import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { codexSource, parseRollout } from './codex.mjs';
import { cachedLogs, filePaths, milliseconds, promptExcerpt, readJSONL, sessionActivity, summarize } from './session-log.mjs';

function textContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
    return block?.type === 'image' ? ['[Image]'] : [];
  }).join('\n').trim();
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function addUsage(bucket, input, output, total = input + output) {
  bucket.requests++;
  bucket.tokens.input += input;
  bucket.tokens.output += output;
  bucket.tokens.total += total;
}

function addPiUsage(bucket, usage) {
  if (!usage) return;
  const input = positive(usage.input) + positive(usage.cacheRead) + positive(usage.cacheWrite);
  const output = positive(usage.output);
  addUsage(bucket, input, output, positive(usage.totalTokens) || input + output);
}

function finishEdit(pending, id, success, bucket) {
  if (success && pending.has(id)) bucket.files.add(pending.get(id));
  pending.delete(id);
}

function trackEdit(pending, id, path, cwd) {
  if (!id || typeof path !== 'string' || !path) return;
  pending.set(id, filePaths([{ path }], cwd)[0]);
}

function piTitle(meta, buckets) {
  const prompts = [...buckets.values()].flatMap(bucket => bucket.prompts).sort((a, b) => a.time - b.time);
  const greeting = /^(?:hello|hi|hey)[!.\s]*$/i;
  const opening = promptExcerpt(prompts[0]?.text ?? '');
  if (opening.files.length && opening.body) return opening.files[0];
  if (greeting.test(opening.body)) {
    for (const prompt of prompts.slice(1)) {
      const { body, files } = promptExcerpt(prompt.text);
      if (body && !greeting.test(body)) return body.split('\n', 1)[0];
      if (files.length) return files[0];
    }
  }
  for (const bucket of buckets.values()) {
    const file = bucket.files.values().next().value;
    if (file) return `Edits to ${basename(file)}`;
  }
  return meta.cwd ? `Session in ${basename(meta.cwd) || meta.cwd}` : 'Untitled session';
}

async function parsePi({ path }, size, observe) {
  let meta;
  let model;
  let system;
  const activity = sessionActivity();
  const pending = new Map();
  const seen = new Set();
  for await (const entry of readJSONL(path, size - 1)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!meta) {
      if (entry.type !== 'session' || typeof entry.id !== 'string' || !entry.id) return null;
      meta = { id: entry.id, cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        forkTime: entry.parentSession ? milliseconds(entry.timestamp) : 0 };
      continue;
    }
    if (entry.id && seen.has(entry.id)) continue;
    if (entry.id) seen.add(entry.id);
    if (entry.type === 'session_info') {
      meta.title = typeof entry.name === 'string' ? entry.name : '';
      continue;
    }
    if (entry.type === 'model_change') {
      if (typeof entry.modelId === 'string') model = entry.modelId;
      continue;
    }
    const message = entry.message;
    if (entry.type === 'message' && message?.role === 'system') {
      system ||= textContent(message.content)
        || Object.values(message.sections ?? {}).filter(part => typeof part === 'string').join('\n\n');
      continue;
    }
    const time = milliseconds(entry.timestamp ?? message?.timestamp);
    // A Pi fork copies the parent's history ahead of its first new turn.
    if (!Number.isFinite(time) || time < meta.forkTime) continue;
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (entry.usage) addPiUsage(activity.record(time), entry.usage);
      continue;
    }
    if (entry.type !== 'message' || !message) continue;
    if (!['user', 'assistant', 'toolResult', 'bashExecution'].includes(message.role)) continue;
    observe?.(time, message);
    const bucket = activity.record(time);
    if (message.role === 'assistant') {
      if (typeof message.model === 'string') model = message.model;
      addPiUsage(bucket, message.usage);
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call?.type === 'toolCall' && ['write', 'edit'].includes(call.name)) {
          trackEdit(pending, call.id, call.arguments?.path, meta.cwd);
        }
      }
    } else if (message.role === 'user') {
      const text = textContent(message.content);
      if (text) bucket.prompts.push({ time, text });
    } else if (message.role === 'toolResult') {
      finishEdit(pending, message.toolCallId, !message.isError, bucket);
    }
    bucket.model = model || bucket.model;
  }
  activity.finish();
  if (meta && !meta.title?.trim()) meta.title = piTitle(meta, activity.buckets);
  return meta && { meta, buckets: activity.buckets, instructions: system ? { system } : undefined };
}

function claudePrompt(record) {
  if (record.isMeta || record.isCompactSummary || record.sourceToolAssistantUUID
      || record.promptSource === 'system' || record.rowSource === 'harness'
      || (record.origin?.kind && record.origin.kind !== 'human')) return '';
  const text = textContent(record.message.content);
  if (record.origin?.kind === 'human') return text;
  if (/^<(?:task-notification|system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(text)
      || /^\[Request interrupted by user(?: for tool use)?\]$/.test(text)) return '';
  const command = text.match(/<command-name>(.*?)<\/command-name>/s);
  if (text.startsWith('<command-name>') && command) {
    const args = text.match(/<command-args>(.*?)<\/command-args>/s);
    return [command[1], args?.[1]].filter(Boolean).join(' ').trim();
  }
  return text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/)?.[1] ?? text;
}

async function parseClaude({ path }, size, observe) {
  const activity = sessionActivity();
  const pending = new Map();
  const requests = new Map();
  const seen = new Set();
  const filename = basename(path, '.jsonl');
  // Resumed/forked transcripts can contain rows belonging to another session.
  const meta = { id: /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(filename) ? filename : null };
  let customTitle;
  for await (const record of readJSONL(path, size - 1)) {
    if (!record || record.isSidechain || typeof record.sessionId !== 'string' || !record.sessionId) continue;
    meta.id ||= record.sessionId;
    if (meta.id !== record.sessionId) continue;
    if (record.type === 'custom-title') {
      if (typeof record.customTitle === 'string') customTitle = record.customTitle;
      continue;
    }
    if (record.type === 'ai-title') {
      if (typeof record.aiTitle === 'string') meta.title = record.aiTitle;
      continue;
    }
    const time = milliseconds(record.timestamp);
    if (!Number.isFinite(time)) continue;
    if (record.type === 'system' && record.subtype === 'turn_duration') {
      activity.record(time);
      continue;
    }
    if (!['user', 'assistant'].includes(record.type) || !record.message) continue;
    if (record.uuid && seen.has(record.uuid)) continue;
    if (record.uuid) seen.add(record.uuid);
    if (typeof record.cwd === 'string' && record.cwd) meta.cwd ||= record.cwd;
    const message = record.message;
    observe?.(time, message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (record.type === 'user') {
      const text = claudePrompt(record);
      const results = blocks.filter(block => block?.type === 'tool_result');
      if (!text && !results.length) continue;
      const bucket = activity.record(time);
      if (text) bucket.prompts.push({ time, text });
      for (const result of results) finishEdit(pending, result.tool_use_id, !result.is_error, bucket);
      continue;
    }
    const bucket = activity.record(time);
    if (typeof message.model === 'string' && message.model !== '<synthetic>') bucket.model = message.model;
    for (const call of blocks) {
      if (call?.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(call.name)) {
        trackEdit(pending, call.id, call.input?.file_path || call.input?.notebook_path, meta.cwd);
      }
    }
    const usage = message.usage;
    if (!usage || message.model === '<synthetic>') continue;
    const input = positive(usage.input_tokens) + positive(usage.cache_read_input_tokens)
      + positive(usage.cache_creation_input_tokens);
    const output = positive(usage.output_tokens);
    // Claude emits multiple content blocks carrying the same response's usage.
    const key = message.id || record.requestId || record.uuid;
    const previous = requests.get(key);
    if (key && previous) {
      previous.input = Math.max(previous.input, input);
      previous.output = Math.max(previous.output, output);
    } else if (key) {
      requests.set(key, { bucket, input, output });
    } else {
      addUsage(bucket, input, output);
    }
  }
  for (const { bucket, input, output } of requests.values()) addUsage(bucket, input, output);
  if (customTitle) meta.title = customTitle;
  activity.finish();
  return meta.id && { meta, buckets: activity.buckets };
}

async function discover(directory, source) {
  const files = [];
  let unreadable = 0;
  async function list(dir) {
    return readdir(dir, { withFileTypes: true }).catch(error => {
      if (error.code !== 'ENOENT') unreadable++;
      return [];
    });
  }
  function collect(dir, entries) {
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')
          && !(source === 'claude' && entry.name.startsWith('agent-'))) {
        files.push({ path: join(dir, entry.name) });
      }
    }
  }
  const entries = await list(directory);
  // Pi also accepts a flat --session-dir. Claude subagent transcripts live deeper.
  if (source === 'pi') collect(directory, entries);
  await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const dir = join(directory, entry.name);
    collect(dir, await list(dir));
  }));
  return { files, unreadable };
}

function transcriptSource(directory, source, parse) {
  const visit = cachedLogs(parse);
  return async () => {
    const found = await discover(directory, source);
    const transcripts = new Map();
    const unreadable = await visit(found.files, (file, parsed, info) => {
      const id = parsed.meta.id;
      const previous = transcripts.get(id);
      if (!previous || info.mtimeMs > previous.mtime || (info.mtimeMs === previous.mtime && file.path < previous.path)) {
        transcripts.set(id, { parsed, path: file.path, mtime: info.mtimeMs, size: info.size });
      }
    });
    const sessions = new Map();
    for (const { parsed: { meta, buckets, instructions }, path, size, mtime } of transcripts.values()) {
      if (!meta.title) {
        const first = [...buckets.values()].find(bucket => bucket.prompts.length)?.prompts[0];
        if (first) meta.title = promptExcerpt(first.text).preview;
      }
      for (const bucket of buckets.values()) {
        const summary = summarize(meta, bucket);
        if (source === 'pi') summary.sessionFile = path;
        sessions.set(`${summary.day}/${meta.id}`, { summary, prompts: bucket.prompts, instructions,
          transcripts: [{ path, size, mtime }] });
      }
    }
    return { unreadable: found.unreadable + unreadable, sessions };
  };
}

export function sessionHistory(env = process.env) {
  const home = homedir();
  const piDirectory = env.PI_CODING_AGENT_SESSION_DIR
    || join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'sessions');
  const piRoot = piDirectory === '~' || piDirectory.startsWith('~/') ? join(home, piDirectory.slice(1)) : piDirectory;
  const sources = [
    ['codex', codexSource(resolve(env.CODEX_HOME || join(home, '.codex')))],
    ['claude', transcriptSource(resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'), 'claude', parseClaude)],
    ['pi', transcriptSource(resolve(piRoot), 'pi', parsePi)],
  ];
  return async () => {
    const results = await Promise.allSettled(sources.map(([, load]) => load()));
    const sessions = new Map();
    let unreadable = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        unreadable++;
        continue;
      }
      const [source] = sources[index];
      unreadable += result.value.unreadable;
      for (const [key, session] of result.value.sessions) {
        session.summary.source = source;
        sessions.set(`${source}/${key}`, session);
      }
    }
    return { sessions, unreadable };
  };
}

export async function readReportTranscript(session, observe) {
  const parse = { codex: parseRollout, claude: parseClaude, pi: parsePi }[session.summary.source];
  for (const file of session.transcripts) {
    if (!await parse(file, file.size, observe)) throw new Error('Session transcript unavailable.');
  }
}
