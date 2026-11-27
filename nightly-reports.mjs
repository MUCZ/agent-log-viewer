import { dayKey } from './session-log.mjs';

const minute = 60_000;

function localMidnight(time, offsetDays = 0) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
}

export function parseClock(value, fallback = '00:30') {
  const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  const [hours, minutes] = match ? [Number(match[1]), Number(match[2])] : fallback.split(':').map(Number);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : parseClock(fallback);
}

// Generates reports for recently finished days in the background. A day is due once it has ended
// and the configured time has passed, so a Mac that slept through the night catches up on wake.
export function nightlyReports({ reports, sessionsForDay, now = Date.now, enabled = true, at = '00:30', lookback = 3,
  retryAfter = 2 * 60 * minute, log = console } = {}) {
  const startMinute = parseClock(at);
  const attempted = new Map();
  let running = null;
  let timer;

  function dueDays(time) {
    const days = [];
    const sinceMidnight = (time - localMidnight(time)) / minute;
    for (let back = 1; back <= lookback; back++) {
      if (back === 1 && sinceMidnight < startMinute) continue;
      days.push(dayKey(localMidnight(time, -back) + 12 * 60 * minute));
    }
    return days;
  }

  async function needsReport(day, sessions) {
    if (!sessions.length) return false;
    const state = await reports.status(day, sessions);
    if (state.progress) return false;
    if (!state.report) return true;
    // A report written while the day was still under way is refreshed once after the day ends.
    const dayEnd = localMidnight(new Date(day + 'T12:00:00').getTime(), 1);
    return state.stale && Date.parse(state.report.generated) < dayEnd;
  }

  async function check() {
    if (!enabled || !await reports.ready()) return [];
    const time = now();
    const generated = [];
    for (const day of dueDays(time)) {
      if (time - (attempted.get(day) ?? -Infinity) < retryAfter) continue;
      const sessions = await sessionsForDay(day);
      if (!await needsReport(day, sessions)) continue;
      attempted.set(day, time);
      await reports.start(day, sessions, false, 'nightly');
      await reports.settle(day);
      const error = reports.lastError(day);
      if (error) log.error?.(`Worklog nightly report for ${day} failed: ${error.message}`);
      else {
        generated.push(day);
        log.log?.(`Worklog generated the nightly report for ${day}.`);
      }
    }
    return generated;
  }

  function tick() {
    running ??= check().catch(error => log.error?.('Worklog nightly report check failed:', error.message))
      .finally(() => { running = null; });
    return running;
  }

  return {
    tick,
    start(interval = 15 * minute, delay = minute) {
      if (!enabled) return;
      setTimeout(tick, delay).unref?.();
      timer = setInterval(tick, interval);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
    describe() {
      const hours = String(Math.floor(startMinute / 60)).padStart(2, '0');
      return { enabled, at: `${hours}:${String(startMinute % 60).padStart(2, '0')}` };
    },
  };
}
