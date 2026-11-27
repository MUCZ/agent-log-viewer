import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { sessionHistory } from './agent-sessions.mjs';
import { dailyReports } from './daily-report.mjs';
import { dayKey } from './session-log.mjs';

const port = Number(process.env.PORT || 3737);
const loadHistory = sessionHistory();
const reports = dailyReports();
const run = promisify(execFile);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/project-tree.js', ['project-tree.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

let snapshot;
let scannedAt = 0;
let scan;
async function getSnapshot() {
  if (snapshot && Date.now() - scannedAt < 10_000) return snapshot;
  scan ??= loadHistory().then(result => {
    const sessions = [...result.sessions.values()].map(({ summary, prompts }) => ({
      ...summary,
      promptTexts: prompts.map(prompt => prompt.text),
    }));
    sessions.sort((a, b) => b.start - a.start || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
    const data = JSON.stringify({
      today: dayKey(Date.now()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unreadable: result.unreadable,
      sessions,
    });
    scannedAt = Date.now();
    snapshot = { data, sessions: result.sessions, directories: new Set(sessions.map(entry => entry.cwd)) };
    return snapshot;
  }).finally(() => { scan = null; });
  return scan;
}

function respond(response, status, contentType, body) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': contentType });
  response.end(body);
}

function json(response, status, data) {
  respond(response, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

async function openInGhostty(request, response, origin) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (request.headers.origin !== origin || (fetchSite && fetchSite !== 'same-origin')) {
    return json(response, 403, { error: 'Open Ghostty from the local Worklog page.' });
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return json(response, 415, { error: 'Expected a JSON request.' });
  }

  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    body += chunk;
    if (body.length > 8192) {
      request.resume();
      return json(response, 413, { error: 'Folder request is too large.' });
    }
  }
  let cwd;
  try {
    cwd = JSON.parse(body)?.cwd;
  } catch {
    return json(response, 400, { error: 'Invalid folder request.' });
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) {
    return json(response, 400, { error: 'This entry has no absolute working directory.' });
  }
  const { directories } = await getSnapshot();
  if (!directories.has(cwd)) {
    return json(response, 404, { error: 'This folder is not in the local session history.' });
  }
  const folder = await stat(cwd).catch(() => null);
  if (!folder?.isDirectory()) {
    return json(response, 404, { error: 'This folder is no longer available on this Mac.' });
  }
  try {
    await run('/usr/bin/open', ['-b', 'com.mitchellh.ghostty', '--', cwd], { timeout: 8000 });
    return json(response, 200, { opened: true });
  } catch {
    return json(response, 503, { error: 'Ghostty could not open this folder. Check that Ghostty is installed on this Mac.' });
  }
}

const server = createServer(async (request, response) => {
  const host = request.headers.host;
  const origin = `http://${host}`;
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!localHosts.includes(host)
      || request.headers.origin && request.headers.origin !== origin
      || request.headers['sec-fetch-site'] === 'cross-site') {
    return json(response, 403, { error: 'Open the viewer from its local address.' });
  }

  try {
    const url = new URL(request.url, origin);
    if (url.pathname === '/api/daily-report') {
      const day = url.searchParams.get('day');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(response, 400, { error: 'Invalid report date.' });
      const generate = request.method === 'POST';
      if (generate && request.headers.origin !== origin) return json(response, 403, { error: 'Open Worklog locally to generate reports.' });
      if (!generate && request.method !== 'GET') return json(response, 405, { error: 'Expected GET or POST.' });
      const { sessions } = await getSnapshot();
      const entries = [...sessions.values()].filter(s => s.summary.day === day);
      const state = generate ? await reports.start(day, entries, url.searchParams.get('regenerate') === '1') : await reports.status(day, entries);
      return json(response, state.progress ? 202 : 200, state);
    }
    if (url.pathname === '/api/open-in-ghostty') {
      if (request.method !== 'POST') return json(response, 405, { error: 'Only POST is supported.' });
      return await openInGhostty(request, response, origin);
    }
    if (request.method !== 'GET') return json(response, 405, { error: 'Only GET is supported.' });
    if (url.pathname === '/api/activity') {
      const { data } = await getSnapshot();
      return respond(response, 200, 'application/json; charset=utf-8', data);
    }
    if (url.pathname === '/api/session') {
      const { sessions } = await getSnapshot();
      const source = url.searchParams.get('source') ?? 'codex';
      const key = `${source}/${url.searchParams.get('day')}/${url.searchParams.get('id')}`;
      const session = sessions.get(key);
      return session ? json(response, 200, { summary: session.summary, prompts: session.prompts, instructions: session.instructions }) : json(response, 404, { error: 'This session is unavailable.' });
    }
    const file = files.get(url.pathname);
    if (!file) return json(response, 404, { error: 'Page not found.' });
    const content = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    return respond(response, 200, file[1], content);
  } catch (error) {
    console.error('Worklog request failed:', error.code || error.message);
    return json(response, 500, { error: 'Could not read the local session history.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to use a different one.` : error.message);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => console.log(`Worklog is available at http://127.0.0.1:${port}`));
