import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { sessionHistory } from '../agent-sessions.mjs';

const id = 'aaaa1111-bbbb-2222-cccc-3333dddd4444';
const cwd = '/projects/sample';
const before = '2026-03-07T23:58:00';
const after = '2026-03-08T00:02:00';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), PI_CODING_AGENT_DIR: join(dir, 'pi'),
  };
  return {
    env, load: sessionHistory(env),
    claude: join(env.CLAUDE_CONFIG_DIR, 'projects', '-projects-sample', id + '.jsonl'),
    pi: join(env.PI_CODING_AGENT_DIR, 'sessions', '--projects-sample--', 'timestamp_' + id + '.jsonl'),
    codex: join(env.CODEX_HOME, 'sessions', '2026', '03', '07', 'rollout-test.jsonl'),
  };
}

async function writeLog(path, records) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map(record => JSON.stringify(record) + '\n').join(''));
}

function claude(type, content, fields = {}, message = {}) {
  return { type, cwd, sessionId: id, timestamp: before, message: { role: type, content, ...message }, ...fields };
}

function pi(role, content, fields = {}, timestamp = before) {
  return { type: 'message', timestamp, message: { role, content, ...fields } };
}

const header = { type: 'session', version: 3, id, cwd, timestamp: before };
const usage = { input_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 2 };

test('indexes same-ID sessions from all three agents with prompts and native paths', async t => {
  const f = await fixture(t);
  await writeLog(f.codex, [
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'response_item', timestamp: before, payload: { type: 'message', role: 'user', content: [{ text: 'Codex question' }] } },
    { type: 'event_msg', timestamp: before, payload: { type: 'user_message', message: 'Codex question' } },
    { type: 'token_usage_record', timestamp: before, payload: { thread_token_usage: { input_tokens: 10, output_tokens: 6 } } },
  ]);
  await writeLog(f.pi, [header, pi('user', [{ type: 'text', text: 'Pi question' }])]);
  await writeLog(f.claude, [claude('user', 'Claude question')]);
  const { sessions, unreadable } = await f.load();
  assert.equal(unreadable, 0);
  assert.equal(sessions.size, 3);
  for (const [source, prompt] of [['pi', 'Pi'], ['claude', 'Claude'], ['codex', 'Codex']]) {
    const { summary, prompts } = sessions.get(`${source}/2026-03-07/${id}`);
    assert.equal(summary.source, source);
    assert.equal(summary.id, id);
    assert.equal(summary.cwd, cwd);
    assert.equal(summary.turns, 1);
    assert.equal(prompts[0].text, prompt + ' question');
    if (source === 'pi') assert.equal(summary.sessionFile, f.pi);
    if (source === 'codex') assert.equal(summary.tokens.total, 16);
  }
});

test('Claude counts an API response once, filters injected messages and tracks confirmed edits', async t => {
  const f = await fixture(t);
  await writeLog(f.claude, [
    { type: 'custom-title', sessionId: id, customTitle: 'Chosen name' },
    { type: 'ai-title', sessionId: id, aiTitle: 'Generated title' },
    claude('user', 'Forked parent text', { sessionId: 'other-session' }),
    claude('user', 'Subagent text', { isSidechain: true }),
    claude('user', [{ type: 'text', text: 'First paragraph' }, { type: 'text', text: 'Searchable second paragraph' }], { uuid: 'a' }),
    claude('user', 'Replayed record', { uuid: 'a' }),
    claude('user', 'Compacted context', { isCompactSummary: true }),
    claude('user', '<task-notification>completed</task-notification>'),
    claude('user', '<bash-stdout>output</bash-stdout>'),
    claude('user', 'Injected metadata', { isMeta: true }),
    claude('user', 'Generated feedback', { origin: { kind: 'task-notification' } }),
    claude('assistant', [{ type: 'text', text: 'Assistant response' }], { uuid: 'b' }, { id: 'response-1', model: 'claude-test', usage }),
    claude('assistant', [{ type: 'tool_use', name: 'Edit', id: 'edit', input: { file_path: cwd + '/ok.py' } },
      { type: 'tool_use', name: 'Write', id: 'write', input: { file_path: 'failed.py' } }], { uuid: 'c' },
    { id: 'response-1', model: 'claude-test', usage: { ...usage, output_tokens: 4 } }),
    claude('assistant', [{ type: 'text', text: 'More output' }], { uuid: 'd' },
      { id: 'response-1', model: 'claude-test', usage: { ...usage, output_tokens: 4 } }),
    claude('user', [{ type: 'tool_result', tool_use_id: 'edit', content: 'Result text' },
      { type: 'tool_result', tool_use_id: 'write', content: 'Tool failure', is_error: true }], { timestamp: after }),
    claude('user', '<pasted_content>User supplied text</pasted_content>', { timestamp: after, origin: { kind: 'human' } }),
    claude('assistant', [], { timestamp: after }, { id: 'response-2', usage }),
  ]);
  await writeLog(join(dirname(f.claude), 'agent-old.jsonl'), [claude('user', 'Nested', { sessionId: 'old-agent' })]);
  await writeLog(join(dirname(f.claude), id, 'subagents', 'agent-a.jsonl'), [claude('user', 'Nested', { sessionId: 'agent' })]);
  const { sessions } = await f.load();
  assert.equal(sessions.size, 2);
  const first = sessions.get('claude/2026-03-07/' + id);
  const second = sessions.get('claude/2026-03-08/' + id);
  assert.equal(first.summary.title, 'Chosen name');
  assert.deepEqual([first.summary.requests, second.summary.requests], [1, 1]);
  assert.deepEqual(first.prompts.map(p => p.text), ['First paragraph\nSearchable second paragraph']);
  assert.deepEqual(second.prompts.map(p => p.text), ['<pasted_content>User supplied text</pasted_content>']);
  assert.deepEqual(first.summary.tokens, { input: 35, output: 4, total: 39 });
  assert.deepEqual(second.summary.tokens, { input: 35, output: 2, total: 37 });
  assert.equal(first.summary.activeMs, 120000);
  assert.equal(second.summary.activeMs, 120000);
  assert.deepEqual(first.summary.files, []);
  assert.deepEqual(second.summary.files, ['ok.py']);
});

test('Pi supports branches, cache usage, structured system instructions and successful writes', async t => {
  const f = await fixture(t);
  await writeLog(f.pi, [
    { ...header, parentSession: '/original.jsonl' },
    pi('user', 'Copied parent prompt', {}, '2026-03-07T23:00:00'),
    pi('system', '', { sections: { preamble: 'System instructions', tools: 'Tool instructions' } }),
    { type: 'model_change', modelId: 'pi-model' },
    pi('user', [{ type: 'text', text: 'Pi first' }, { type: 'image', data: 'omitted' }]),
    { ...pi('assistant', [{ type: 'toolCall', name: 'write', id: 'write', arguments: { path: cwd + '/pi.py' } },
      { type: 'toolCall', name: 'edit', id: 'edit', arguments: { path: cwd + '/failed.py' } }],
    { usage: { input: 11, cacheRead: 12, cacheWrite: 13, output: 14, totalTokens: 50 } }), id: 'assistant-1' },
    { ...pi('assistant', [], { usage: { input: 11, output: 50 } }), id: 'assistant-1' },
    pi('toolResult', [{ type: 'text', text: 'Tool output' }], { toolCallId: 'write' }, after),
    pi('toolResult', 'File error', { toolCallId: 'edit', isError: true }, after),
    { type: 'compaction', timestamp: after, summary: 'Machine summary', usage: { input: 4, output: 2 } },
    { type: 'session_info', name: 'Renamed Pi session' },
  ]);
  const { sessions } = await f.load();
  const first = sessions.get('pi/2026-03-07/' + id);
  const second = sessions.get('pi/2026-03-08/' + id);
  assert.equal(first.summary.title, 'Renamed Pi session');
  assert.deepEqual([first.summary.requests, second.summary.requests], [1, 1]);
  assert.equal(first.summary.model, 'pi-model');
  assert.deepEqual(first.summary.tokens, { input: 36, output: 14, total: 50 });
  assert.deepEqual(first.prompts.map(p => p.text), ['Pi first\n[Image]']);
  assert.equal(first.instructions.system, 'System instructions\n\nTool instructions');
  assert.deepEqual(second.prompts, []);
  assert.deepEqual(second.summary.files, ['pi.py']);
  assert.deepEqual(second.summary.tokens, { input: 4, output: 2, total: 6 });
  assert.equal(first.summary.activeMs, 120000);
  assert.equal(second.summary.activeMs, 120000);
});

test('updates, truncation, missing stores and a broken source are isolated across refreshes', async t => {
  const f = await fixture(t);
  const flat = join(f.env.PI_CODING_AGENT_DIR, 'override');
  const file = join(flat, 'some-session.jsonl');
  const load = sessionHistory({ ...f.env, PI_CODING_AGENT_SESSION_DIR: flat });
  await writeLog(f.pi, [{ ...header, id: 'shadowed' }, pi('user', 'Shadowed')]);
  await writeFile(f.env.CODEX_HOME, 'unreadable directory');
  await writeLog(file, [header, pi('user', 'Initial')]);
  const key = 'pi/2026-03-07/' + id;
  const more = JSON.stringify(pi('user', 'Appended'));
  await appendFile(file, more.slice(0, -4));
  let result = await load();
  assert.equal(result.sessions.size, 1);
  assert.equal(result.unreadable, 1);
  assert.equal(result.sessions.get(key).summary.turns, 1);
  await appendFile(file, more.slice(-4));
  result = await load();
  assert.equal(result.sessions.get(key).summary.turns, 2);
  await writeLog(file, [header, pi('user', 'Rewritten')]);
  assert.equal((await load()).sessions.get(key).prompts[0].text, 'Rewritten');
  await rm(file);
  assert.equal((await load()).sessions.size, 0);
});

test('Codex joins paginated rollouts in time order and selects a single copy of each page', async t => {
  const f = await fixture(t);
  const meta = (timestamp, base) => ({ type: 'session_meta', payload: { timestamp, id, cwd, history_mode: 'paginated', history_base: base } });
  const question = (timestamp, text) => ({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: text } });
  const token = (timestamp, response, delta, total) => ({
    type: 'token_usage_record', timestamp, payload: { response_id: response, thread_token_usage: { total_tokens: total },
      ...(delta == null ? {} : { usage: { total_tokens: delta } }) },
  });
  const base = { thread_id: id, end_ordinal_exclusive: 3, end_byte_offset: 400 };
  await writeLog(f.codex, [meta(before, null), question(before, 'Original'), token(before, 'one', 20, 20)]);
  const next = join(dirname(f.codex), 'rollout-continuation.jsonl');
  const page = [meta(after, base), question(after, 'Continuation'), token(after, 'two', null, 25),
    token(after, 'three', 4, 17), token(after, 'three', 4, 17)];
  await writeLog(next, page);
  await writeLog(join(f.env.CODEX_HOME, 'archived_sessions', 'rollout-backup.jsonl'),
    [meta(after, base), question(after, 'Stale backup')]);
  const first = (await f.load()).sessions;
  assert.equal(first.size, 2);
  const a = first.get('codex/2026-03-07/' + id);
  const b = first.get('codex/2026-03-08/' + id);
  assert.equal(a.summary.tokens.total, 20);
  assert.equal(b.summary.tokens.total, 9);
  assert.deepEqual([a.summary.requests, b.summary.requests], [1, 2]);
  assert.equal(a.summary.activeMs, 120000);
  assert.equal(b.summary.activeMs, 120000);
  assert.equal(a.prompts[0].text, 'Original');
  assert.deepEqual(b.prompts.map(p => p.text), ['Continuation']);
  assert.deepEqual((await f.load()).sessions, first);
  assert.deepEqual((await sessionHistory(f.env)()).sessions, first);
});

test('unchanged legacy Codex token counters do not add requests', async t => {
  const f = await fixture(t);
  const counts = [0, 12, 12, 17].map(total_tokens => ({
    type: 'event_msg', timestamp: before,
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens } } },
  }));
  await writeLog(f.codex, [{ type: 'session_meta', payload: { id, cwd } }, ...counts]);
  const { summary } = (await f.load()).sessions.get('codex/2026-03-07/' + id);
  assert.equal(summary.requests, 2);
  assert.equal(summary.tokens.total, 17);
});
