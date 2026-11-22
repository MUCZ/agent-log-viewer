# Worklog

Worklog is a local, read-only Codex activity dashboard for macOS.

## Start

Requires Node.js 22.13 or newer. From this directory, run:

```sh
npm start
```

Open [Worklog](http://127.0.0.1:3737). The server binds only to loopback. It reads `CODEX_HOME` when set, otherwise `~/.codex`. Set `PORT` to use a different port.

To start Worklog automatically at login and keep it running in the background, see [macOS installation](INSTALLATION.md).

Choose **By date** for a daily overview, or **By project** to browse a working directory's sessions by most recent activity. Cmd-K focuses session search in the current view. Open a session to read its prompts, see changed files, or copy its Codex resume command.

With Ghostty installed, **Open in Ghostty** opens the working directory from a project header or session drawer.

## How the dashboard counts activity

- In the date view, a session appears on each day with recorded activity in the Mac's time zone. In the project view, it appears once under its most recent activity date, with usage and details combined across days.
- Active time adds gaps of up to ten minutes between events within each session. Parallel sessions can overlap.
- Tokens use the cumulative usage recorded in Codex logs. Input includes cached input when Codex reports it that way.
- Session token bars use the largest session total on the selected date or in the selected project as their scale, including sessions hidden by filters.
- Changed files are paths in successful Codex patch events. Edits made through shell commands may be absent.
- The viewer reads active and archived rollouts. It uses the read-only SQLite index for titles and related metadata when available. Subagents and review threads are omitted.

There is no package installation, cloud service, LLM call, or persistent viewer cache.
