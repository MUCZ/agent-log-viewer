import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionActivity } from '../session-log.mjs';

test('groups activity into bursts separated by more than ten idle minutes', () => {
  const noon = new Date(2026, 2, 7, 12).getTime();
  const minute = 60_000;
  const activity = sessionActivity();
  for (const offset of [0, 4, 9, 25, 30, 60]) activity.record(noon + offset * minute);
  activity.finish();
  const [bucket] = activity.buckets.values();
  assert.deepEqual(bucket.segments, [
    [noon, noon + 9 * minute],
    [noon + 25 * minute, noon + 30 * minute],
    [noon + 60 * minute, noon + 60 * minute],
  ]);
  assert.equal(bucket.activeMs, 14 * minute);
});
