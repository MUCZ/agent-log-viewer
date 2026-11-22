import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { codexSource, dayKey } from './codex.mjs';

const port = Number(process.env.PORT || 3737);
const home = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
const loadCodex = codexSource(home);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
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
  scan ??= loadCodex().then(result => {
    const sessions = [...result.sessions.values()].map(item => item.summary);
    sessions.sort((a, b) => b.start - a.start);
    const data = JSON.stringify({
      today: dayKey(Date.now()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unreadable: result.unreadable,
      sessions,
    });
    scannedAt = Date.now();
    snapshot = { data, sessions: result.sessions };
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

const server = createServer(async (request, response) => {
  const host = request.headers.host;
  const localHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!localHosts.includes(host)
      || request.headers.origin && request.headers.origin !== `http://${host}`
      || request.headers['sec-fetch-site'] === 'cross-site') {
    return json(response, 403, { error: 'Open the viewer from its local address.' });
  }
  if (request.method !== 'GET') return json(response, 405, { error: 'Only GET is supported.' });

  try {
    const url = new URL(request.url, `http://${host}`);
    if (url.pathname === '/api/activity') {
      const { data } = await getSnapshot();
      return respond(response, 200, 'application/json; charset=utf-8', data);
    }
    if (url.pathname === '/api/session') {
      const { sessions } = await getSnapshot();
      const key = `${url.searchParams.get('day')}/${url.searchParams.get('id')}`;
      const session = sessions.get(key);
      return session ? json(response, 200, session) : json(response, 404, { error: 'This session is unavailable.' });
    }
    const file = files.get(url.pathname);
    if (!file) return json(response, 404, { error: 'Page not found.' });
    const content = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
    return respond(response, 200, file[1], content);
  } catch (error) {
    console.error('Worklog request failed:', error.code || error.message);
    return json(response, 500, { error: 'Could not read the local Codex history.' });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to use a different one.` : error.message);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => console.log(`Worklog is available at http://127.0.0.1:${port}`));
