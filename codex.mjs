import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cachedLogs, dayKey, filePaths, milliseconds, readJSONL, sessionActivity, summarize } from './session-log.mjs';

export { dayKey } from './session-log.mjs';
const internalSources = new Set(['subagent', 'guardian_review', 'onboarding_checklist']);
const agentsHeader = /^# AGENTS\.md instructions[^\r\n]*\r?\n\s*<INSTRUCTIONS>\s*([\s\S]*?)\s*<\/INSTRUCTIONS>\s*/i;

function isInternal(source, threadSource) {
  return internalSources.has(threadSource) || typeof source === 'object' && source !== null
    || typeof source === 'string' && source.includes('subagent');
}

async function scanRollouts(directory, archived = false) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const groups = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scanRollouts(path, archived);
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) return [];
    return [{ path, archived }];
  }));
  return groups.flat();
}

async function threadMetadata(home) {
  const files = await readdir(home).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const versions = files.filter(file => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const file of versions) {
    let db;
    try {
      db = new DatabaseSync(join(home, file), { readOnly: true });
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name));
      if (!columns.has('id')) continue;
      const fields = [
        'id', 'title', 'name', 'cwd', 'model', 'source', 'thread_source', 'archived', 'rollout_path',
      ].filter(field => columns.has(field));
      return new Map(db.prepare(`SELECT ${fields.join(', ')} FROM threads`).all().map(row => [row.id, row]));
    } catch (error) {
      console.warn(`Could not read ${file} (${error.code || 'SQLite error'}). Using rollout files.`);
    } finally {
      db?.close();
    }
  }
  return new Map();
}

function plainPrompt(value) {
  return typeof value === 'string'
    ? value.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '').trim()
    : '';
}

function promptContent(value) {
  if (!Array.isArray(value)) return plainPrompt(value);
  return plainPrompt(value.map(part => part.text ?? '').join('\n'));
}

function tokenValue(usage, key) {
  if (!usage) return;
  return usage[key + '_tokens'] ?? (key === 'total' ? usage.input_tokens + usage.output_tokens : undefined);
}

function tokenDeltas(records, buckets) {
  const previous = { input: 0, output: 0, total: 0 };
  const seen = new Set();
  for (const { time, usage, delta, responseId } of records) {
    if (responseId && seen.has(responseId)) continue;
    if (responseId) seen.add(responseId);
    const bucket = buckets.get(dayKey(time));
    const tokens = bucket.tokens;
    const before = tokens.total;
    for (const key of ['input', 'output', 'total']) {
      const value = tokenValue(usage, key);
      const increment = tokenValue(delta, key);
      if (Number.isFinite(increment)) {
        tokens[key] += Math.max(0, increment);
        previous[key] = Number.isFinite(value) ? value : previous[key] + increment;
      } else if (Number.isFinite(value)) {
        tokens[key] += Math.max(0, value - previous[key]);
        previous[key] = Math.max(previous[key], value);
      }
    }
    if (responseId || delta || tokens.total > before) bucket.requests++;
  }
}

async function parseRollout(file, size) {
  let meta;
  let cwd;
  let lastModel;
  const activity = sessionActivity();
  const { buckets, bucketAt } = activity;
  const modernUsage = [];
  const legacyUsage = [];
  const toolCalls = new Map();
  const systemPrompts = new Set();
  let agentsInstructions;
  let previousPrompt;

  function onPrompt(time, text, source) {
    if (!text) return;
    const duplicate = previousPrompt && previousPrompt.source !== source && Math.abs(time - previousPrompt.time) < 3000;
    const instructions = text.match(agentsHeader);
    if (instructions) {
      const message = text.slice(instructions[0].length);
      if (!previousPrompt) {
        agentsInstructions ??= instructions[1];
        text = message;
      } else if (duplicate && agentsInstructions === instructions[1] && previousPrompt.text === message) {
        return;
      }
    }
    if (!text || duplicate && previousPrompt.text === text) return;
    bucketAt(time).prompts.push({ time, text });
    previousPrompt = { time, text, source };
  }

  for await (const record of readJSONL(file.path, size - 1)) {
    if (!record || typeof record !== 'object') continue;
    const p = record.payload ?? {};
    if (record.type === 'session_meta') {
      if (!meta) {
        if (isInternal(p.source, p.thread_source)) return null;
        meta = p;
        cwd = meta.cwd;
        const base = plainPrompt(meta.base_instructions?.text ?? meta.base_instructions);
        if (base) systemPrompts.add(base);
      }
      continue;
    }
    if (!meta) continue;
    const time = milliseconds(record.timestamp);
    if (!Number.isFinite(time)) continue;

    const item = p.item;
    const isEvent = record.type === 'event_msg';
    const isResponse = record.type === 'response_item';
    if (record.type === 'turn_context') {
      lastModel = p.model || lastModel;
      cwd = p.cwd || cwd;
    } else if (record.type === 'token_usage_record' && (p.thread_token_usage || p.usage)) {
      modernUsage.push({ time, usage: p.thread_token_usage, delta: p.usage, responseId: p.response_id });
    } else if (isEvent && p.type === 'token_count' && p.info?.total_token_usage) {
      legacyUsage.push({ time, usage: p.info.total_token_usage });
    } else if (isEvent && p.type === 'user_message') {
      onPrompt(time, plainPrompt(p.message), 'event');
    } else if (isEvent && p.type === 'item_completed' && item?.type === 'UserMessage') {
      onPrompt(time, promptContent(item.content), 'item');
    } else if (isResponse && p.type === 'message' && p.role === 'user') {
      onPrompt(time, promptContent(p.content), 'response');
    } else if (isResponse && p.type === 'message' && (p.role === 'system'
      || p.role === 'developer' && !previousPrompt && !systemPrompts.size)) {
      const text = promptContent(p.content);
      if (text) systemPrompts.add(text);
    } else if (isEvent && (
      p.type === 'item_completed' && ['FileChange', 'fileChange', 'file_change'].includes(item?.type)
        && item.status === 'completed'
      || p.type === 'patch_apply_end' && p.success === true
    )) {
      for (const path of filePaths(item?.changes ?? p.changes, cwd)) bucketAt(time).files.add(path);
    } else if (isResponse && p.name === 'apply_patch' && p.call_id) {
      // Older rollouts can store apply_patch as a call and its result only.
      let patch = p.input;
      if (!patch && typeof p.arguments === 'string') {
        try {
          const args = JSON.parse(p.arguments);
          patch = args.patch ?? args.input;
        } catch { /* Unrecognized call. */ }
      }
      if (typeof patch === 'string') {
        const paths = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)];
        toolCalls.set(p.call_id, paths.map(match => ({ path: match[1].trim() })));
      }
    } else if (isResponse && /^(?:custom_tool_call_output|function_call_output)$/.test(p.type) && toolCalls.has(p.call_id)) {
      const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      if (/Success\. Updated the following files/i.test(output)
        && !/(?:Exit code|Process exited with code)\s*[: ]\s*[1-9]/i.test(output)) {
        for (const path of filePaths(toolCalls.get(p.call_id), cwd)) bucketAt(time).files.add(path);
      }
      toolCalls.delete(p.call_id);
    }

    const isActivity = record.type === 'turn_context' || record.type === 'token_usage_record'
      || isResponse && p.role !== 'developer'
      || isEvent && /^(?:item_(?:started|completed)|task_(?:started|complete)|turn_aborted|user_message|agent_message|patch_apply_end)$/.test(p.type)
      || isEvent && p.type === 'token_count' && p.info;
    if (isActivity) {
      const bucket = activity.record(time);
      bucket.model = lastModel || bucket.model;
    }
  }
  if (typeof meta?.id !== 'string' || !meta.id) return null;
  const usage = modernUsage.length ? modernUsage : legacyUsage;
  return { meta, buckets, times: activity.times, usage,
    instructions: { system: [...systemPrompts].join('\n\n'), agents: agentsInstructions } };
}

function assemblePages(pages, thread) {
  // New Codex rollouts append disjoint pages to a thread. Archived copies of
  // the same page can coexist with its live file.
  const unique = new Map();
  for (const page of pages.sort((a, b) =>
    Number(b.path === thread?.rollout_path) - Number(a.path === thread?.rollout_path)
    || Number(a.archived) - Number(b.archived) || a.path.localeCompare(b.path))) {
    const meta = page.parsed.meta;
    const key = meta.history_mode === 'paginated' && meta.history_base
      ? JSON.stringify([meta.timestamp, meta.history_base.end_ordinal_exclusive, meta.history_base.end_byte_offset]) : 'initial';
    if (!unique.has(key)) unique.set(key, page);
  }
  const selected = [...unique.values()].sort((a, b) =>
    (milliseconds(a.parsed.meta.timestamp) || a.parsed.times[0] || 0)
    - (milliseconds(b.parsed.meta.timestamp) || b.parsed.times[0] || 0));
  const activity = sessionActivity();
  const usage = [];
  const instructions = {};
  for (const { parsed } of selected) {
    for (const time of parsed.times) activity.record(time);
    for (const slice of parsed.buckets.values()) {
      const bucket = activity.bucketAt(slice.start);
      for (const prompt of slice.prompts) bucket.prompts.push(prompt);
      for (const file of slice.files) bucket.files.add(file);
      bucket.model = slice.model || bucket.model;
    }
    for (const record of parsed.usage) usage.push(record);
    instructions.system ||= parsed.instructions.system;
    instructions.agents ||= parsed.instructions.agents;
  }
  for (const bucket of activity.buckets.values()) bucket.prompts.sort((a, b) => a.time - b.time);
  activity.finish();
  tokenDeltas(usage.sort((a, b) => a.time - b.time), activity.buckets);
  return { meta: selected[0].parsed.meta, buckets: activity.buckets, instructions,
    archived: selected.every(page => page.archived) };
}

export function codexSource(home) {
  const visit = cachedLogs(parseRollout);

  return async function load() {
    const [metadata, live, archived] = await Promise.all([
      threadMetadata(home), scanRollouts(join(home, 'sessions')),
      scanRollouts(join(home, 'archived_sessions'), true),
    ]);
    const files = [...live, ...archived];
    const threads = new Map();
    const unreadable = await visit(files, (file, parsed) => {
      const id = parsed.meta.id;
      const thread = metadata.get(id);
      if (isInternal(thread?.source, thread?.thread_source)) return;
      if (!threads.has(id)) threads.set(id, []);
      threads.get(id).push({ ...file, parsed });
    });
    const sessions = new Map();
    for (const [id, pages] of threads) {
      const thread = metadata.get(id);
      const { meta, buckets, instructions, archived } = assemblePages(pages, thread);
      for (const bucket of buckets.values()) {
        const summary = summarize(meta, bucket, thread, archived);
        sessions.set(`${summary.day}/${id}`, { summary, prompts: bucket.prompts, instructions });
      }
    }
    return { sessions, unreadable };
  };
}
