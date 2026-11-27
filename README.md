# Worklog

Worklog is a local, read-only activity dashboard for Codex, Claude Code and Pi on macOS.

## Start

Requires Node.js 22.13 or newer. From this directory, run:

```sh
npm start
```

Open [Worklog](http://127.0.0.1:3737). The server binds to loopback. Set `PORT` to use a different port.

| Agent | Default session directories | Environment override |
| --- | --- | --- |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | `CODEX_HOME` |
| Claude Code | `~/.claude/projects` | `CLAUDE_CONFIG_DIR` |
| Pi | `~/.pi/agent/sessions` | `PI_CODING_AGENT_DIR`, or `PI_CODING_AGENT_SESSION_DIR` for the session directory itself |

To start Worklog automatically at login and keep it running in the background, see [macOS installation](INSTALLATION.md).

Choose **By date** to see daily session counts and token usage or use the calendar to revisit an active day. **By project** opens on the last three calendar days, including today in the server's time zone. Select **1 day**, **3 days** or **7 days** to change the window for the tree, folder totals, search and session details.

Use **All agents** to filter either view by source. Cmd-K focuses search, which matches session IDs, titles, directories, recorded file paths and the full text of user prompts. Open a session to read its prompts, see changed files or copy the command to resume it in its original agent.

With Ghostty installed, **Open in Ghostty** opens the working directory from a project header or session drawer.

## How the dashboard counts activity

- In the date view, a session appears on each day with recorded activity in the Mac's time zone. The project view counts each session once and combines its daily activity within the selected window. Parent folders include their descendants by default.
- Project request counts use model responses with recorded usage. For older Codex logs that only record cumulative usage, each increase counts as one request.
- Active time adds gaps of up to ten minutes between events within each session. Parallel sessions can overlap.
- Codex token counts use per-response usage when available and cumulative counters for older logs. Continued rollouts contribute to the same session. Claude Code and Pi report usage per assistant message. Input includes separately reported cache reads and writes.
- Session token bars use the largest session total on the selected date or in the selected project as their scale, including sessions hidden by filters.
- Changed files come from successful patch, edit and write tools. Edits made through shell commands may be absent.
- For Codex, Worklog also reads archived rollouts and uses the read-only SQLite index for titles and related metadata when available. Codex subagents and review threads are omitted.

There is no package installation, cloud service, LLM call, or persistent viewer cache.
