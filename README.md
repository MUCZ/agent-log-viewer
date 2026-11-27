# Worklog

Worklog is a local, read-only activity dashboard for Codex, Claude Code and Pi on macOS.

## Platform scope

Develop and test Worklog for desktop browsers on macOS only. Mobile development and mobile testing are outside the project's scope.

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

## Daily reports

Open the **Daily report** page from the top toolbar. The button shows whether a report is saved. It opens the selected day in **By date** and today in **By project**. Select **Generate report** to create the report. Worklog uses the whole local day across projects and harnesses. It selects short excerpts from dated user requests, assistant replies, confirmed edits and available command outcomes. Two direct OpenRouter API steps extract tasks in small batches and group them into a Chinese report by project. This creates no harness session. Track progress through reading, task analysis and writing. Each project lists concrete changes and related PR, issue or document links when available. **Copy Markdown** includes these links.

The server uses `google/gemini-4-hydrogen`. Set `OPENROUTER_API_KEY` or point `WORKLOG_OPENROUTER_KEY_FILE` at a file containing the raw key. By default it reads `~/Library/Application Support/Worklog/openrouter.key`. Generation sends excerpts and project hints to OpenRouter. Reports, usage and reusable task assessments are saved in `~/Library/Application Support/Worklog/reports`. Opening a saved report makes no model request. **Regenerate report** works even with unchanged activity. It reuses current assessments and rewrites the report while the saved version remains readable.

## How the dashboard counts activity

- In the date view, a session appears on each day with recorded activity in the Mac's time zone. The project view counts each session once and combines its daily activity within the selected window. Parent folders include their descendants by default.
- Project request counts use model responses with recorded usage. For older Codex logs that only record cumulative usage, each increase counts as one request.
- Active time adds gaps of up to ten minutes between events within each session. Parallel sessions can overlap.
- Codex token counts use per-response usage when available and cumulative counters for older logs. Continued rollouts contribute to the same session. Claude Code and Pi report usage per assistant message. Input includes separately reported cache reads and writes.
- Session token bars use the largest session total on the selected date or in the selected project as their scale, including sessions hidden by filters.
- Changed files come from successful patch, edit and write tools. Edits made through shell commands may be absent.
- For Codex, Worklog also reads archived rollouts and uses the read-only SQLite index for titles and related metadata when available. Codex subagents and review threads are omitted.

Browsing session history runs locally and requires no package installation or model API key.
