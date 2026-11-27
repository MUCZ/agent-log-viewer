import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { dailyReports } from '../daily-report.mjs';
import { sessionHistory } from '../agent-sessions.mjs';

test('daily reports isolate the day, reuse assessments and preserve saved reports on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-report-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const date = '2026-11-26';
  const load = sessionHistory({ PI_CODING_AGENT_SESSION_DIR: dir, CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude') });
  async function makeLog(id) {
    const message = (day, role, content) => ({ type: 'message', timestamp: day + 'T12:00:00', message: { role, content } });
    const log = [{ type: 'session', id, cwd: dir }, message(date, 'system', 'system-private'),
      message(date, 'user', 'Review https://github.com/example/repo/pull/17 carefully'), message(date, 'assistant', [{ type: 'text', text: 'Identified a regression' }]),
      message(date, 'toolResult', 'tool-private'), message('2026-11-27', 'assistant', 'tomorrow-private')];
    await writeFile(join(dir, id + '.jsonl'), log.map(v => JSON.stringify(v)).join('\n'));
  }
  const entries = async () => [...(await load()).sessions.values()].filter(s => s.summary.day === date);
  const batches = [];
  let fail = false;
  const options = { directory: join(dir, 'reports'), key: async () => 'test', complete: async (_, prompt, data, schema) => {
    if (fail) throw new Error('Model unavailable.');
    let value;
    if (schema.properties.sessions) {
      batches.push(data.length);
      const text = JSON.stringify(data);
      assert.match(text, /Identified a regression/);
      assert.doesNotMatch(text, /system-private|tool-private|tomorrow-private/);
      value = { sessions: data.map(({ index }) => ({ index, tasks: [{ project: 'Example', repository: '', evidence: 'Found a regression in PR #17.', links: ['https://github.com/example/repo/pull/17', 'https://invented.example'] }] })) };
    } else {
      assert.deepEqual(data[0].links, ['https://github.com/example/repo/pull/17']);
      value = { projects: [{ name: 'Example', bullets: [{ text: 'Found a regression in PR #17.',
        links: ['https://github.com/example/repo/pull/17', 'https://invented.example'] }] }] };
    }
    return { value, usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } };
  } };
  const service = dailyReports(options);
  async function finish(sessions) {
    for (let i = 0; i < 200; i++) {
      const state = await service.status(date, sessions);
      if (!state.progress) return state;
      await delay(10);
    }
    assert.fail('Generation timed out');
  }
  await makeLog('first');
  let sessions = await entries();
  await Promise.all([service.start(date, sessions), service.start(date, sessions)]);
  const first = await finish(sessions);
  assert.equal(first.error, undefined);
  assert.equal(first.report.analyzed, 1);
  assert.equal(first.stale, false);
  assert.deepEqual(first.report.projects[0].bullets[0].links, ['https://github.com/example/repo/pull/17']);
  assert.equal(first.report.usage.cost, 0.02);
  assert.deepEqual((await dailyReports(options).status(date, sessions)).report, first.report);
  await service.start(date, sessions);
  assert.deepEqual(batches, [1]);
  await makeLog('second');
  sessions = await entries();
  fail = true;
  await service.start(date, sessions);
  const failed = await finish(sessions);
  assert.match(failed.error, /Model unavailable/);
  assert.deepEqual(failed.report, first.report);
  fail = false;
  await service.start(date, sessions);
  const second = await finish(sessions);
  assert.equal(second.report.analyzed, 2);
  assert.deepEqual(batches, [1, 1]);
  await service.start(date, sessions, true);
  const regenerated = await finish(sessions);
  assert.equal(regenerated.report.usage.requests, 1);
  assert.deepEqual(batches, [1, 1]);
  await makeLog('unreadable');
  sessions = await entries();
  await rm(join(dir, 'unreadable.jsonl'));
  await service.start(date, sessions);
  const partial = await finish(sessions);
  assert.equal(partial.report.total, 3);
  assert.equal(partial.report.analyzed, 2);
  assert.equal(partial.stale, true);
});
