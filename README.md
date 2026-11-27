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

Choose **By date** to see daily session counts and token usage or use the calendar to revisit an active day. The arrow keys and the buttons beside the date step between active days. The **Timeline** shows when each project was active during the day. Each bar is a burst of activity, and gaps longer than ten minutes are left out. Hover a bar for details or click it to open the session. **By project** opens on the last three calendar days, including today in the server's time zone. Select **1 day**, **3 days** or **7 days** to change the window for the tree, folder totals, search and session details.

Use the **All · Codex · Claude · Pi** switch in the toolbar to filter either view by source. Cmd-K focuses search, which matches session IDs, titles, directories, recorded file paths and the full text of user prompts. Open a session to read its prompts, see changed files or copy the command to resume it in its original agent.

Worklog follows the system light or dark appearance. Use the theme button at the bottom of the sidebar to choose **Auto**, **Light** or **Dark**.

With Ghostty installed, **Open in Ghostty** opens the working directory from a project header or session drawer.

## Daily reports

In **By date**, switch the day page from **Activity** to **Daily report**. The tab shows whether a report is saved, and a small mark in the history list flags days that have one. The calendar, history list and arrow keys keep working, so you can step through reports day by day. Each report has its own address, such as `#report/2026-11-27`.

Select **Generate report** to summarize the whole local day across projects and agents. A report opens with a one-line headline and counts of finished, in-progress and blocked work. Each project lists short items. An item has a headline, one line of detail, a type (Feature, Fix, Review, QA, Research, Maintenance or Other), a status and links to the PRs, issues or documents behind it. Filter by type, or switch between grouping **Projects** and **Types**. **Follow-ups** collects open questions and next steps left in the logs. **Copy Markdown** produces the same report as text.

Generation reads each session's requests paired with the agent's final reply, successful edits, and the outcome of commits, pushes, PR actions and test runs. A first OpenRouter step turns each session into typed work records. Worklog groups the records by repository. A second step merges and words them by project, citing the records it used. Worklog drops any item without a supporting record, adds back any record the writer left out and attaches only links seen in that session. This creates no harness session. Track progress through reading, task analysis and writing.

**Nightly reports.** While the Worklog server runs, it generates the previous day's report after 00:30. If the Mac was asleep or off, it catches up when the server is running again, covering up to three days back. It only generates for days with activity and no report, or with a report saved before the day ended that has since changed. Nightly generation needs an OpenRouter key. Set `WORKLOG_NIGHTLY_REPORTS=off` to disable it or `WORKLOG_NIGHTLY_REPORT_TIME=HH:MM` to change the time.

The server uses `google/gemini-4-hydrogen`. Set `OPENROUTER_API_KEY` or point `WORKLOG_OPENROUTER_KEY_FILE` at a file containing the raw key. By default it reads `~/Library/Application Support/Worklog/openrouter.key`. Generation sends excerpts and project hints to OpenRouter. Reports, usage and reusable session records are saved in `~/Library/Application Support/Worklog/reports`, or in `WORKLOG_REPORT_DIR` when set. Opening a saved report makes no model request. **Regenerate** works even with unchanged activity. It reuses session records and rewrites the report while the saved version remains readable. Reports saved by earlier versions still open and gain types and follow-ups when regenerated.

## How the dashboard counts activity

- In the date view, a session appears on each day with recorded activity in the Mac's time zone. The project view counts each session once and combines its daily activity within the selected window. Parent folders include their descendants by default.
- Project request counts use model responses with recorded usage. For older Codex logs that only record cumulative usage, each increase counts as one request.
- Active time adds gaps of up to ten minutes between events within each session. Parallel sessions can overlap.
- Codex token counts use per-response usage when available and cumulative counters for older logs. Continued rollouts contribute to the same session. Claude Code and Pi report usage per assistant message. Input includes separately reported cache reads and writes.
- Session token bars use the largest session total on the selected date or in the selected project as their scale, including sessions hidden by filters.
- Changed files come from successful patch, edit and write tools. Edits made through shell commands may be absent.
- For Codex, Worklog also reads archived rollouts and uses the read-only SQLite index for titles and related metadata when available. Codex subagents and review threads are omitted.

Browsing session history runs locally and requires no package installation or model API key.
