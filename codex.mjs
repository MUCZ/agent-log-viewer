import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const idleGap = 10 * 60 * 1000;
const internalSources = new Set(['subagent', 'guardian_review', 'onboarding_checklist']);
const agentsHeader = /^# AGENTS\.md instructions[^\r\n]*\r?\n\s*<INSTRUCTIONS>\s*([\s\S]*?)\s*<\/INSTRUCTIONS>\s*/i;

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

function milliseconds(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

function localMidnight(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function isInternal(source, threadSource) {
  return internalSources.has(threadSource) || typeof source === 'object' && source !== null
    || typeof source === 'string' && source.includes('subagent');
}

async function* readJSONL(file, end) {
  const lines = createInterface({
    input: createReadStream(file, { encoding: 'utf8', end }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    try {
      yield JSON.parse(line);
    } catch {
      // A running session can leave a partially written final record.
    }
  }
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
        'id', 'title', 'name', 'cwd', 'model', 'source', 'thread_source', 'archived',
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

function headline(text, length = 96) {
  const line = text?.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  const points = Array.from(line);
  return points.length <= length ? line : points.slice(0, length - 1).join('') + '…';
}

function filePaths(changes, cwd) {
  const entries = Array.isArray(changes)
    ? changes.flatMap(change => [change.path, change.move_path])
    : Object.entries(changes ?? {}).flatMap(([path, change]) => [path, change?.move_path]);
  return entries.filter(path => typeof path === 'string' && path.length).map(path => {
    if (!cwd || !isAbsolute(path)) return normalize(path);
    const short = relative(cwd, path);
    return short && !short.startsWith('../') && !isAbsolute(short) ? short : path;
  });
}

function tokenDeltas(records, buckets) {
  let previous = { input: 0, output: 0, total: 0 };
  for (const { time, usage } of records) {
    const tokens = buckets.get(dayKey(time)).tokens;
    const values = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      total: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    };
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(value)) continue;
      tokens[key] += Math.max(0, value - previous[key]);
      previous[key] = Math.max(previous[key], value);
    }
  }
}

async function parseRollout(file, size) {
  let meta;
  let cwd;
  let lastModel;
  const buckets = new Map();
  const activity = [];
  const modernUsage = [];
  const legacyUsage = [];
  const toolCalls = new Map();
  const systemPrompts = new Set();
  let agentsInstructions;
  let previousPrompt;

  function bucketAt(time) {
    const day = dayKey(time);
    if (!buckets.has(day)) {
      buckets.set(day, {
        day, start: time, end: time, activeMs: 0, prompts: [], files: new Set(),
        tokens: { input: 0, output: 0, total: 0 }, model: null,
      });
    }
    return buckets.get(day);
  }

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
    } else if (record.type === 'token_usage_record' && p.thread_token_usage) {
      modernUsage.push({ time, usage: p.thread_token_usage });
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
      activity.push(time);
      const bucket = bucketAt(time);
      bucket.start = Math.min(bucket.start, time);
      bucket.end = Math.max(bucket.end, time);
      bucket.model = lastModel || bucket.model;
    }
  }
  if (!meta?.id) return null;
  activity.sort((a, b) => a - b);
  for (let index = 1; index < activity.length; index++) {
    const previous = activity[index - 1];
    const current = activity[index];
    const gap = current - previous;
    if (gap > idleGap) continue;
    const startOfDay = localMidnight(current);
    if (previous < startOfDay) {
      bucketAt(previous).activeMs += startOfDay - previous;
      bucketAt(current).activeMs += current - startOfDay;
    } else {
      bucketAt(current).activeMs += gap;
    }
  }
  tokenDeltas(modernUsage.length ? modernUsage : legacyUsage, buckets);
  return { meta, buckets, instructions: { system: [...systemPrompts].join('\n\n'), agents: agentsInstructions } };
}

function summarize(meta, bucket, thread, archived) {
  const cwd = thread?.cwd || meta.cwd || '';
  const firstPrompt = bucket.prompts[0]?.text || '';
  const title = headline(thread?.name || thread?.title) || headline(firstPrompt) || 'Untitled session';
  return {
    id: meta.id,
    day: bucket.day,
    start: bucket.start,
    end: bucket.end,
    activeMs: bucket.activeMs,
    cwd,
    projectName: cwd ? basename(cwd) || cwd : 'No working directory',
    title,
    preview: headline(firstPrompt, 180),
    model: bucket.model || thread?.model || null,
    turns: bucket.prompts.length,
    files: [...bucket.files].sort(),
    tokens: bucket.tokens,
    archived: Boolean(thread?.archived || archived),
  };
}

export function codexSource(home) {
  const cache = new Map();

  async function read(file) {
    const info = await stat(file.path);
    if (!info.size) return null;
    const signature = `${info.size}:${info.mtimeMs}`;
    const earlier = cache.get(file.path);
    if (earlier?.signature === signature) return earlier.parsed;
    const parsed = await parseRollout(file, info.size);
    cache.set(file.path, { signature, parsed });
    return parsed;
  }

  return async function load() {
    const [metadata, live, archived] = await Promise.all([
      threadMetadata(home), scanRollouts(join(home, 'sessions')),
      scanRollouts(join(home, 'archived_sessions'), true),
    ]);
    const files = [...live, ...archived];
    const paths = new Set(files.map(file => file.path));
    for (const path of cache.keys()) {
      if (!paths.has(path)) cache.delete(path);
    }
    const sessions = new Map();
    let unreadable = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++];
        const parsed = await read(file).catch(() => {
          unreadable++;
          return null;
        });
        if (!parsed) continue;
        const { meta, buckets, instructions } = parsed;
        const thread = metadata.get(meta.id);
        if (isInternal(thread?.source, thread?.thread_source)) continue;
        for (const bucket of buckets.values()) {
          const summary = summarize(meta, bucket, thread, file.archived);
          const key = `${summary.day}/${meta.id}`;
          const existing = sessions.get(key);
          if (!existing || file.archived === false) {
            sessions.set(key, { summary, prompts: bucket.prompts, instructions });
          }
        }
      }
    }));
    return { sessions, unreadable };
  };
}
