import { execFile } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readReportTranscript } from './agent-sessions.mjs';
import { dayKey } from './session-log.mjs';

const run = promisify(execFile);

function excerpt(text, limit) {
  const clean = text.replace(/<(system-reminder|environment_context|INSTRUCTIONS)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
    .replace(/<image\b[^>]*>\s*<\/image>/gi, '[image]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[\w-]{12,}/g, '[redacted]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+\//g, '~/').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : clean.slice(0, limit * .7) + ' ... ' + clean.slice(-limit * .3);
}

function sample(items, count) {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round(i * (items.length - 1) / (count - 1))]);
}

async function repoIdentity(dir) {
  if (!isAbsolute(dir)) return null;
  const git = async args => (await run('/usr/bin/git', ['-C', dir, ...args], { timeout: 2000 })).stdout.trim();
  try {
    const remote = await git(['config', '--get', 'remote.origin.url']);
    const url = new URL(remote.replace(/^([\w.-]+)@([\w.-]+):/, 'ssh://$1@$2/'));
    if (url.hostname) return url.hostname.toLowerCase() + url.pathname.replace(/\.git\/?$/, '');
  } catch { /* Local repositories may only have a common directory. */ }
  try {
    const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return excerpt(common.replace(/\/\.git$/, ''), 240);
  } catch { return null; }
}

export async function reportEvidence(session, repoCache) {
  const { summary, prompts } = session;
  const messages = [];
  const seen = new Set();
  function add(time, role, content) {
    if (typeof content !== 'string') return;
    const text = excerpt(content, 500);
    const key = role + '\n' + text;
    if (text && !seen.has(key)) {
      seen.add(key);
      messages.push({ time, role, text });
    }
  }
  for (const prompt of prompts) add(prompt.time, 'request', prompt.text);
  await readReportTranscript(session, (time, event) => {
    if (dayKey(time) !== summary.day) return;
    if (event.role === 'assistant' && Array.isArray(event.content)) {
      for (const block of event.content) {
        if (['text', 'output_text'].includes(block?.type)) add(time, 'reply', block.text);
      }
    } else if (event.role === 'assistant') add(time, 'reply', event.content);
    else if (event.type === 'agent_message') add(time, 'reply', event.message);
    if (event.type === 'exec_command_end' && Number.isInteger(event.exit_code)) {
      const command = Array.isArray(event.command) ? event.command.join(' ') : '';
      const operation = command.match(/\b(npm test|node --test|pytest|go test|cargo test|git push)\b/)?.[1];
      if (operation) add(time, 'command result', operation + ' command line exited ' + event.exit_code);
    }
  });
  messages.sort((a, b) => a.time - b.time);
  const files = sample(summary.files, 12);
  const dirs = [summary.cwd, ...files.map(file => dirname(resolve(summary.cwd || '/', file)))];
  const repos = [];
  for (const dir of new Set(dirs)) {
    if (!repoCache.has(dir)) repoCache.set(dir, repoIdentity(dir));
    const repo = await repoCache.get(dir);
    if (repo && !repos.includes(repo)) repos.push(repo);
  }
  return {
    cwd: excerpt(summary.cwd, 220), repositories: repos, edits: files.map(f => excerpt(f, 180)),
    events: sample(messages, 16).map(({ role, text }) => [role, text]),
  };
}
