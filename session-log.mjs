import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, normalize, relative } from 'node:path';
import { createInterface } from 'node:readline';

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

export function milliseconds(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

function localMidnight(timestamp) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export async function* readJSONL(file, end) {
  const input = createReadStream(file, { encoding: 'utf8', end });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // A running session may have a partially written final record.
      }
      yield record;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function headline(text, length = 96) {
  const line = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!line) return '';
  const points = Array.from(line);
  return points.length <= length ? line : points.slice(0, length - 1).join('') + '…';
}

// Keep attachment metadata out of list excerpts. The transcript retains the original text.
export function promptExcerpt(text) {
  const files = [];
  const body = text.replace(/<image\b[^>]*?\bpath="([^"]+)"[^>]*>\s*<\/image>/gi, (_, path) => {
    files.push(basename(path));
    return ' ';
  }).trim().replace(/^(?:(?:@|\/|~\/|\.{1,2}\/)[^\s<>]+\.\w+(?:\s+|$))+/u, refs => {
    for (const ref of refs.trim().split(/\s+/)) files.push(basename(ref.replace(/^@/, '')));
    return '';
  }).trim();
  return { body, files, preview: headline(body || files.join(' · '), 180) };
}

export function filePaths(changes, cwd) {
  const entries = Array.isArray(changes)
    ? changes.flatMap(change => [change.path, change.move_path])
    : Object.entries(changes ?? {}).flatMap(([path, change]) => [path, change?.move_path]);
  return entries.filter(path => typeof path === 'string' && path.length).map(path => {
    if (!cwd || !isAbsolute(path)) return normalize(path);
    const short = relative(cwd, path);
    return short && !short.startsWith('../') && !isAbsolute(short) ? short : path;
  });
}

const IDLE_GAP = 10 * 60 * 1000;

export function sessionActivity() {
  const activity = [];
  const buckets = new Map();
  function bucketAt(time) {
    const day = dayKey(time);
    if (!buckets.has(day)) {
      buckets.set(day, {
        day, start: time, end: time, activeMs: 0, prompts: [], files: new Set(),
        tokens: { input: 0, output: 0, total: 0 }, requests: 0, model: null,
      });
    }
    return buckets.get(day);
  }

  function record(time) {
    activity.push(time);
    const bucket = bucketAt(time);
    bucket.start = Math.min(bucket.start, time);
    bucket.end = Math.max(bucket.end, time);
    return bucket;
  }

  function finish() {
    activity.sort((a, b) => a - b);
    // Bursts of events separated by at most the idle gap, kept per local day for timelines.
    for (const bucket of buckets.values()) bucket.segments = [];
    for (const time of activity) {
      const segments = bucketAt(time).segments;
      const last = segments.at(-1);
      if (last && time - last[1] <= IDLE_GAP) last[1] = time;
      else segments.push([time, time]);
    }
    for (let index = 1; index < activity.length; index++) {
      const previous = activity[index - 1];
      const current = activity[index];
      const gap = current - previous;
      if (gap > IDLE_GAP) continue;
      const startOfDay = localMidnight(current);
      if (previous < startOfDay) {
        bucketAt(previous).activeMs += startOfDay - previous;
        bucketAt(current).activeMs += current - startOfDay;
      } else {
        bucketAt(current).activeMs += gap;
      }
    }
  }
  return { buckets, bucketAt, record, finish, times: activity };
}

export function summarize(meta, bucket, thread = meta, archived) {
  const directory = thread?.cwd || meta.cwd;
  const cwd = typeof directory === 'string' ? directory : '';
  const { preview } = promptExcerpt(bucket.prompts[0]?.text ?? '');
  const title = headline(thread?.name || thread?.title) || headline(preview) || 'Untitled session';
  return {
    id: meta.id,
    day: bucket.day,
    start: bucket.start,
    end: bucket.end,
    activeMs: bucket.activeMs,
    segments: bucket.segments ?? [[bucket.start, bucket.end]],
    cwd,
    projectName: cwd ? basename(cwd) || cwd : 'No working directory',
    title,
    preview,
    model: bucket.model || thread?.model || null,
    turns: bucket.prompts.length,
    requests: bucket.requests,
    files: [...bucket.files].sort(),
    tokens: bucket.tokens,
    archived: Boolean(thread?.archived || archived),
  };
}

export function cachedLogs(parse) {
  const cache = new Map();
  return async function visit(files, apply) {
    const paths = new Set(files.map(file => file.path));
    for (const path of cache.keys()) {
      if (!paths.has(path)) cache.delete(path);
    }
    let unreadable = 0;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++];
        try {
          const info = await stat(file.path);
          if (!info.size) continue;
          const signature = `${info.size}:${info.mtimeMs}`;
          let item = cache.get(file.path);
          if (item?.signature !== signature) {
            item = { signature, parsed: await parse(file, info.size) };
            cache.set(file.path, item);
          }
          if (item.parsed) apply(file, item.parsed, info);
        } catch {
          unreadable++;
        }
      }
    }));
    return unreadable;
  };
}
