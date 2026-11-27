import { execFile } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readReportTranscript } from './agent-sessions.mjs';
import { dayKey } from './session-log.mjs';

const run = promisify(execFile);

function excerpt(text, limit) {
  const clean = String(text ?? '').replace(/<(system-reminder|environment_context|INSTRUCTIONS)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '')
    .replace(/<image\b[^>]*>\s*<\/image>/gi, '[image]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[\w-]{12,}/g, '[redacted]')
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\/Users\/[^/\s]+\//g, '~/').replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : clean.slice(0, limit * .7) + ' ... ' + clean.slice(-limit * .3);
}

// Evenly spaced picks that always keep the first and last item.
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

// Preserve observed artifact URLs without forwarding auth parameters or local viewer links.
function artifactLinks(content) {
  const urls = [];
  for (const match of content.matchAll(/https?:\/\/[^\s<>"'\x60\]），。；]+/giu)) {
    try {
      const url = new URL(match[0].replace(/[).,;:!?]+$/, ''));
      if (url.username || url.password || url.hostname === 'localhost' || url.hostname === '127.0.0.1'
        || url.hostname === '[::1]' || url.href.length > 600 || /(?:token|signature|credential|key|auth|secret|password)/i.test(url.search)) continue;
      urls.push(url.href);
    } catch { /* An excerpt can contain an incomplete URL. */ }
  }
  return urls;
}

const quoted = /(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/;

// Shell commands whose outcome says something concrete about the work: commits, pushes, PRs and checks.
export function notableCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const line = command.replace(/\s+/g, ' ');
  if (/\bgit\b[^|;&]*\bcommit\b/.test(line)) {
    const heredoc = command.match(/\bgit\b[^\n]*\bcommit\b[^\n]*<<-?\s*['"]?(\w+)['"]?\n\s*([^\n]+)/);
    const message = heredoc?.[2] ?? line.match(new RegExp(String.raw`\bcommit\b[^|;&]*?(?:-m|--message)[= ]\s*` + quoted.source))?.slice(1).find(Boolean);
    return 'git commit' + (message ? ': ' + message.split('\\n')[0] : '');
  }
  const pr = line.match(/\bgh (pr|issue) (create|merge|review|comment|close|edit)\b/);
  if (pr) {
    const title = line.match(new RegExp(String.raw`--title[= ]\s*` + quoted.source))?.slice(1).find(Boolean);
    const target = line.match(/\bgh (?:pr|issue) \w+ (#?\d+)/)?.[1];
    return `gh ${pr[1]} ${pr[2]}` + (target ? ' ' + target : '') + (title ? ': ' + title : '');
  }
  if (/\bgit push\b/.test(line)) return 'git push';
  const integrate = line.match(/\bgit (merge|rebase)(?![-\w])/);
  if (integrate) return "git " + integrate[1];
  const check = line.match(/\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|bun test|node --test|pytest|go test|go vet|cargo test|cargo clippy|vitest|jest|make test|npm run (?:lint|build|typecheck)|tsc --noEmit|ruff check|mypy)\b/);
  return check ? 'check: ' + check[1] : null;
}

function assistantTexts(event) {
  if (event?.type === 'agent_message' && typeof event.message === 'string') return [event.message];
  if (event?.role !== 'assistant') return [];
  if (typeof event.content === 'string') return [event.content];
  return (Array.isArray(event.content) ? event.content : [])
    .filter(block => ['text', 'output_text'].includes(block?.type) && typeof block.text === 'string').map(block => block.text);
}

export async function reportEvidence(session, repoCache) {
  const { summary } = session;
  const prompts = [...session.prompts].sort((a, b) => a.time - b.time);
  const links = new Set();
  const replies = new Map();
  const calls = new Map();
  const commands = [];
  const collectLinks = text => { for (const url of artifactLinks(excerpt(text, 12000))) links.add(url); };
  const turnAt = time => {
    let turn = -1;
    while (turn + 1 < prompts.length && prompts[turn + 1].time <= time) turn++;
    return turn;
  };
  function outcome(time, command, ok) {
    const label = notableCommand(command);
    if (label) commands.push({ time, text: excerpt(label, 220) + (ok ? ' → succeeded' : ' → failed') });
  }
  for (const prompt of prompts) collectLinks(prompt.text);

  await readReportTranscript(session, (time, event) => {
    if (dayKey(time) !== summary.day) return;
    for (const text of assistantTexts(event)) {
      if (!text.trim()) continue;
      collectLinks(text);
      // The last reply of a turn usually states what was done, so it represents the turn's outcome.
      replies.set(turnAt(time), text);
    }
    const blocks = Array.isArray(event?.content) ? event.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use' && /^bash$/i.test(block.name) && typeof block.input?.command === 'string') calls.set(block.id, block.input.command);
      if (block?.type === 'toolCall' && /^bash$/i.test(block.name) && typeof block.arguments?.command === 'string') calls.set(block.id, block.arguments.command);
      if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) outcome(time, calls.get(block.tool_use_id), !block.is_error);
    }
    if (event?.role === 'toolResult' && calls.has(event.toolCallId)) outcome(time, calls.get(event.toolCallId), !event.isError);
    if (event?.role === 'bashExecution' && typeof event.command === 'string') outcome(time, event.command, (event.exitCode ?? 0) === 0);
    if (event?.type === 'item_completed' && event.item?.type === 'CommandExecution' && Number.isInteger(event.item.exit_code)) {
      const command = Array.isArray(event.item.command) ? event.item.command.join(' ') : event.item.command;
      outcome(time, command, event.item.exit_code === 0);
    }
    if (event?.type === 'exec_command_end' && Number.isInteger(event.exit_code)) {
      const command = Array.isArray(event.command) ? event.command.join(' ') : event.command;
      outcome(time, command, event.exit_code === 0);
    }
  });

  const turns = [];
  if (replies.has(-1)) turns.push({ request: '(continued from an earlier day)', outcome: excerpt(replies.get(-1), 600) });
  const seen = new Set();
  for (const [index, prompt] of prompts.entries()) {
    const request = excerpt(prompt.text, 420);
    if (!request || seen.has(request)) continue;
    seen.add(request);
    turns.push({ request, outcome: replies.has(index) ? excerpt(replies.get(index), 600) : '' });
  }
  const recentCommands = [];
  for (const command of commands.sort((a, b) => a.time - b.time).reverse()) {
    if (!recentCommands.includes(command.text)) recentCommands.unshift(command.text);
    if (recentCommands.length === 12) break;
  }

  const files = sample(summary.files, 16);
  const dirs = [summary.cwd, ...files.map(file => dirname(resolve(summary.cwd || '/', file)))];
  const repos = [];
  for (const dir of new Set(dirs)) {
    if (!repoCache.has(dir)) repoCache.set(dir, repoIdentity(dir));
    const repo = await repoCache.get(dir);
    if (repo && !repos.includes(repo)) repos.push(repo);
  }
  return {
    title: excerpt(summary.title, 160),
    agent: summary.source,
    cwd: excerpt(summary.cwd, 220),
    repositories: repos,
    edits: files.map(f => excerpt(f, 180)),
    commands: recentCommands,
    links: sample([...links], 24),
    turns: sample(turns, 18),
  };
}
