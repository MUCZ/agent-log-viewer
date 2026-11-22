# Worklog

Worklog is a local, read-only Codex activity dashboard for macOS.

## Start

Requires Node.js 22.13 or newer. From this directory, run:

```sh
npm start
```

Open [Worklog](http://127.0.0.1:3737). The server binds only to loopback. It reads `CODEX_HOME` when set, otherwise `~/.codex`. Set `PORT` to use a different port.

Pick a date, filter by working directory, or search across the indexed sessions with Cmd-K. Open a session to read its prompts and changed paths for the selected date, or copy its Codex resume command. The page picks up new activity while open.

## How the dashboard counts activity

- A session appears on each day where it has rollout activity, using the Mac's time zone. Session counts are per day.
- Active time adds gaps of up to ten minutes between events within each session. Parallel sessions can overlap.
- Tokens use the cumulative usage recorded in Codex logs. Input includes cached input when Codex reports it that way.
- Session token bars use the largest session total on the selected date as their scale, including sessions hidden by filters.
- Changed files are paths in successful Codex patch events. Edits made through shell commands may be absent.
- The viewer reads active and archived rollouts. It uses the read-only SQLite index for titles and related metadata when available. Subagents and review threads are omitted.

There is no package installation, cloud service, LLM call, or persistent viewer cache.
