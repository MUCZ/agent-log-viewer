import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assembleReport, dailyReports, groupTasks, normalizeRepository } from '../daily-report.mjs';
import { sessionHistory } from '../agent-sessions.mjs';
import { notableCommand } from '../report-evidence.mjs';
import { nightlyReports, parseClock } from '../nightly-reports.mjs';

const pr = 'https://github.com/example/repo/pull/17';

test('daily reports isolate the day, reuse assessments and preserve saved reports on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-report-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const date = '2026-11-26';
  const load = sessionHistory({ PI_CODING_AGENT_SESSION_DIR: dir, CODEX_HOME: join(dir, 'codex'), CLAUDE_CONFIG_DIR: join(dir, 'claude') });
  async function makeLog(id) {
    const message = (day, role, content, extra) => ({ type: 'message', timestamp: day + 'T12:00:00', message: { role, content, ...extra } });
    const log = [{ type: 'session', id, cwd: dir }, message(date, 'system', 'system-private'),
      message(date, 'user', `Review ${pr} carefully`),
      message(date, 'assistant', [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git commit -m "Fix the PR 17 regression"' } }]),
      message(date, 'toolResult', 'tool-private', { toolCallId: 'c1', isError: false }),
      message(date, 'assistant', [{ type: 'text', text: 'Identified a regression' }]),
      message('2026-11-27', 'assistant', 'tomorrow-private')];
    await writeFile(join(dir, id + '.jsonl'), log.map(v => JSON.stringify(v)).join('\n'));
  }
  const entries = async () => [...(await load()).sessions.values()].filter(s => s.summary.day === date);
  const batches = [];
  let fail = false;
  const options = { directory: join(dir, 'reports'), key: async () => 'test', retryDelay: 0, complete: async (_, prompt, data, schema) => {
    if (fail) throw new Error('Model unavailable.');
    let value;
    if (schema.properties.sessions) {
      batches.push(data.length);
      const text = JSON.stringify(data);
      assert.match(text, /Identified a regression/);
      assert.match(text, /git commit: Fix the PR 17 regression → succeeded/);
      assert.doesNotMatch(text, /system-private|tool-private|tomorrow-private/);
      value = { sessions: data.map(({ index }) => ({ index, tasks: [{ title: '评审 PR #17', detail: '发现回归问题', kind: 'review', status: 'done',
        project: 'repo', repository: 'example/repo', open: '', links: [pr, 'https://invented.example'] }] })) };
    } else {
      assert.equal(data.groups[0].repository, 'github.com/example/repo');
      assert.doesNotMatch(JSON.stringify(data), /invented/);
      value = { headline: '评审了 PR #17', followUps: [],
        projects: [{ name: 'repo', summary: '评审', items: [{ kind: 'review', status: 'done', title: '评审 PR #17', detail: '发现回归问题',
          sources: data.groups[0].records.map(r => r.id) }] }] };
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
  assert.equal(first.report.version, 3);
  assert.equal(first.report.trigger, 'manual');
  assert.equal(first.report.analyzed, 1);
  assert.equal(first.stale, false);
  assert.equal(first.report.projects[0].repository, 'github.com/example/repo');
  assert.deepEqual(first.report.projects[0].items[0].links, [pr]);
  assert.equal(first.report.usage.cost, 0.02);
  assert.deepEqual((await dailyReports(options).status(date, sessions)).report, first.report);
  assert.deepEqual(Object.keys(await service.list()), [date]);
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
  await service.start(date, sessions, true, 'nightly');
  const regenerated = await finish(sessions);
  assert.equal(regenerated.report.usage.requests, 1);
  assert.equal(regenerated.report.trigger, 'nightly');
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

test('assembling a report drops unsupported items and restores omitted work and follow-ups', () => {
  const task = (id, extra) => ({ id, title: 'T' + id, detail: '', kind: 'feature', status: 'done', project: 'app', repository: 'github.com/o/app', open: '', links: [], ...extra });
  const tasks = [task(0, { links: ['https://x.test/0'] }), task(1), task(2, { repository: '', project: 'misc', status: 'in_progress', open: '还要确认缓存策略' }),
    task(3, { kind: 'fix', status: 'blocked' })];
  const report = assembleReport({
    headline: 'H',
    projects: [{ name: 'App', summary: 'S', items: [
      { kind: 'feature', status: 'done', title: 'Merged', detail: '', sources: [0, 1, 0] },
      { kind: 'fix', status: 'done', title: 'Claimed done', detail: '', sources: [3] },
      { kind: 'feature', status: 'done', title: 'Invented', detail: '', sources: [99] },
    ] }],
    followUps: [{ text: 'Invented follow-up', sources: [0] }],
  }, tasks);
  assert.equal(report.projects[0].repository, 'github.com/o/app');
  assert.deepEqual(report.projects[0].items.map(i => [i.title, i.status]), [['Merged', 'done'], ['Claimed done', 'blocked']]);
  assert.deepEqual(report.projects[0].items[0].links, ['https://x.test/0']);
  assert.equal(report.projects[1].name, '其他工作');
  assert.deepEqual(report.projects[1].items.map(i => i.title), ['T2']);
  assert.deepEqual(report.followUps, [{ text: '还要确认缓存策略', project: '其他工作', links: [] }]);
  assert.ok(report.projects.every(p => p.items.every(i => !('sources' in i))));
});

test('records group by normalized repository', () => {
  assert.equal(normalizeRepository('git@github.com:Owner/Repo.git'), 'github.com/Owner/Repo');
  assert.equal(normalizeRepository('Owner/Repo'), 'github.com/Owner/Repo');
  assert.equal(normalizeRepository('https://www.github.com/owner/repo/'), 'github.com/owner/repo');
  const { groups, unassigned } = groupTasks([
    { id: 0, repository: 'github.com/o/a', title: 'a' }, { id: 1, repository: 'github.com/O/A', title: 'b' }, { id: 2, repository: '', title: 'c' }]);
  assert.deepEqual(groups.map(g => [g.repository, g.records.map(r => r.id)]), [['github.com/o/a', [0, 1]]]);
  assert.deepEqual(unassigned.map(r => r.id), [2]);
});

test('notable commands keep commit messages, PR actions and checks', () => {
  assert.equal(notableCommand('git add . && git commit -m "Add the day timeline"'), 'git commit: Add the day timeline');
  assert.equal(notableCommand("git commit -q -F - <<'EOF'\nRedesign the report\n\nBody\nEOF"), 'git commit: Redesign the report');
  assert.equal(notableCommand('git commit -m "$(cat <<\'EOF\'\nFix overflow\nEOF\n)"'), 'git commit: Fix overflow');
  assert.equal(notableCommand('gh pr create --title "Nightly reports" --body x'), 'gh pr create: Nightly reports');
  assert.equal(notableCommand('gh pr merge 42 --squash'), 'gh pr merge 42');
  assert.equal(notableCommand('cd app && npm test 2>&1 | tail'), 'check: npm test');
  assert.equal(notableCommand('git push -u origin main'), 'git push');
  assert.equal(notableCommand('ls -la'), null);
});

test('nightly reports generate finished days once, after the configured time', async () => {
  assert.equal(parseClock('3:05'), 185);
  assert.equal(parseClock('nope'), 30);
  const saved = new Map();
  const started = [];
  let clock = new Date(2026, 10, 28, 0, 10).getTime();
  const reports = {
    ready: async () => true,
    status: async (day, sessions) => ({ day, report: saved.get(day), stale: !saved.has(day) || saved.get(day).stale, total: sessions.length }),
    start: async (day, sessions, regenerate, trigger) => {
      started.push([day, trigger]);
      saved.set(day, { generated: new Date(clock).toISOString(), stale: false });
    },
    settle: async () => {},
    lastError: () => undefined,
  };
  const activeDays = new Set(['2026-11-27', '2026-11-25']);
  const nightly = nightlyReports({ reports, now: () => clock, at: '00:30', log: {},
    sessionsForDay: async day => activeDays.has(day) ? [{ day }] : [] });
  assert.deepEqual(await nightly.tick(), ['2026-11-25']);
  clock = new Date(2026, 10, 28, 0, 45).getTime();
  assert.deepEqual(await nightly.tick(), ['2026-11-27']);
  assert.deepEqual(await nightly.tick(), []);
  // A report saved mid-day becomes stale after more work; it is refreshed after the day ends.
  saved.set('2026-11-28', { generated: new Date(2026, 10, 28, 15).toISOString(), stale: true });
  activeDays.add('2026-11-28');
  clock = new Date(2026, 10, 29, 1).getTime();
  assert.deepEqual(await nightly.tick(), ['2026-11-28']);
  assert.deepEqual(started.map(([day, trigger]) => day + ':' + trigger), ['2026-11-25:nightly', '2026-11-27:nightly', '2026-11-28:nightly']);
  const off = nightlyReports({ reports, enabled: false, sessionsForDay: async () => [{}] });
  assert.deepEqual(await off.tick(), []);
});
