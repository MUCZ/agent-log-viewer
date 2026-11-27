# Daily report

Product design draft for the macOS desktop dashboard.

## Reader and purpose

The primary reader is the engineer returning to yesterday's work. In about 30 seconds they should recognize the projects they worked on, recall what moved forward in each, and see any questions explicitly left open. Worklog discovers those projects from the day's activity. The reader can generate a report without naming projects, assigning sessions or configuring folder rules.

## Reading experience

The report is the second tab of the day page in **By date**, beside **Activity**, with a dated URL. The sidebar, date heading and day stepper stay in place, so moving between days or back to the session list takes one action. The history list marks days with a saved report. The report belongs to the entire local calendar day. Its header shows the date, time zone and “All projects and agents” even when a search or harness filter is active. Keep the entry accessible when filters hide all sessions on an otherwise active day.

On first use, select **Generate report** on the page. Show progress as sessions analyzed out of the day's total. Once saved, opening the page goes straight to the report. Show the saved timestamp and allow regeneration even when activity is unchanged. Keep the saved report readable while processing. A failed update preserves the saved version. A day with zero sessions gets a short empty state.

## What a report looks like

Illustrative English rendering. The proposed default report language is Chinese for personal recall. Preserve project names, file names and issue identifiers verbatim.

> **Friday, November 27**
>
> Asia/Tokyo · All projects and agents · 12 of 12 sessions analyzed
>
> **agent_log_viewer**
>
> Aligned session rows across Codex, Claude and Pi. Verified both desktop views at four window widths.
>
> Removed the project dropdown and date arrows. Verified date and project selection from the sidebar.
>
> **ponsu**
>
> Reviewed feedback on PR #715 and drafted a follow-up issue.
>
> Open question: should the fix also cover resumed sessions?

Open with a one-line headline and counts of done, in-progress and blocked items. Give each project with substantive work a heading, a one-sentence summary and short items. Each item leads with a verb-first headline naming the artifact, adds at most one sentence of detail, and carries a type and a status:

| Type | Covers |
| --- | --- |
| Feature | New or extended capability or UI |
| Fix | Repairing a bug or regression |
| Review | Reviewing code, PRs or feedback, replying to reviewers |
| QA | Testing, verifying, reproducing, benchmarking |
| Research | Investigating, analysing, designing, planning, writing proposals or docs |
| Maintenance | Refactoring, configuration, dependencies, CI, releases, environment, cleanup |
| Other | Anything else |

Status is **done** only when the logs show completion, **in progress** when work started but was not finished or verified, and **blocked** when a failure or blocker was left unresolved. The reader can filter by type and group by project or by type. Open questions and next steps recorded in the logs appear under **Follow-ups**. Omit greetings and setup chatter. The reading page and **Copy Markdown** both present a standalone report in the same order. Each bullet can link to the observed PR, issue or document that makes its outcome concrete. Both formats omit session references.

## How projects are discovered

A project is a recognizable body of work, such as Worklog or Ponsu. Each heading answers “what was I working on?” and the bullets under it answer “what happened there?” The same project can span several worktrees, checkouts, harnesses and tasks. An explicitly named research effort can also be a project without a repository. Prefer the most specific project name supported by the actual work. A broad product name shared by several independently maintained repositories is weak evidence for merging them.

### Report generation

Call OpenRouter directly using Gemini 4 Hydrogen. A report creates no harness session. Use ordinary code for dates, repository identity, grouping, counts, links and coverage. Give the model two bounded jobs: interpreting sessions and writing the day.

1. **Collect the day's evidence.** For each session, pair each user request with the agent's final reply in that turn, which usually states what was done. Add the session title, successful edits, and the outcome of commits (with their message), pushes, PR actions and checks such as test runs, across Codex, Claude Code and Pi. Attach the repository of the files actually worked on and its normalized remote identity. A Git common directory can identify sibling worktrees locally.
2. **Extract typed work records from each session.** Produce one record per deliverable with a headline, one line of detail, type, status, project, owner-qualified repository, any explicitly recorded open question, and supporting links copied from that session. Split when the user moves to a different deliverable or project. A mention made for comparison does not create another record. Sessions are processed in small parallel batches. A failed batch is retried session by session, so one bad session counts against coverage instead of failing the report.
3. **Group in code, then write.** Group records sharing a canonical repository, comparing case-insensitively. The writer turns each repository group into exactly one project, places records without a repository only when the evidence matches, and puts the rest under **Other work**. It merges records about the same deliverable into one item and cites the record ids behind every item and follow-up.
4. **Check against the records.** Drop items and follow-ups without a valid source. Downgrade a claimed **done** when none of its records is done. Attach only links observed in the cited sessions. Add back any record or open question the writer left out, so no work goes missing. Count unreadable sessions and failed analyses in the coverage indicator.

### Example from a mixed day

| Activity observed in logs | Where it belongs |
| --- | --- |
| Codex implements a change under `workspace/ponsu`. Claude reviews it under `review/ponsu`. Both checkouts identify the same repository and PR. | One **Ponsu** section. Combine implementation and review in one bullet when they concern the same change. |
| Pi starts in `~/workspace`, reviews a fully qualified Ponsu PR, then edits Worklog's session rows on a separate request. | Two work records, one for **Ponsu** and one for **Worklog**. The session counts once toward coverage. |
| A Worklog prompt uses a Ponsu session as an example of a layout issue. | **Worklog** only. The deliverable is the layout fix. |
| Two sessions refine the same explicitly named research proposal in temporary folders. | One section named for the **research proposal**, even without Git metadata. |
| Two unrelated remotes share a basename. A separate session only says “review #715” from a generic directory. | Keep the repositories distinct using owner-qualified names. Leave the ambiguous review in **Other work** unless further evidence resolves it. |

## What counts as evidence

| Recorded evidence | Wording the report can support |
| --- | --- |
| A user asks for a change, with no later outcome | “Requested …” |
| The conversation records a decision or diagnosis | “Decided …” or “Identified …”, with the supported detail |
| A successful edit is recorded | “Updated …” for the observed change |
| A test command returns success, or a push is confirmed | “Tests passed” or “Pushed …”, scoped to that result |

The current index exposes prompts, titles, usage and file paths. Generation also needs relevant assistant replies and tool outcomes from the local logs. Read them on demand for the chosen date. A changed filename alone cannot establish that a bug was fixed. Keep system instructions, credentials and unrelated tool output out of model input.

## Scope, coverage and storage

- Start with every indexed Codex, Claude and Pi session active on the selected day, using the dashboard's time zone. For a session spanning midnight, use that day's activity. A result recorded after midnight belongs to the following report.
- Count a session as analyzed once its day-specific evidence has been read and assessed. A successfully assessed greeting counts. An unreadable session or failed analysis does not. Attempt all sessions, including short ones.
- Show the actual coverage count. At least 90% coverage meets the existing project target. If any sessions are missing, identify them and offer a retry. Below 90%, label the result **Partial report**, including in copied Markdown.
- Store the report and internal assessments locally, separately from source logs. Reopening a saved report makes no model call. On update, reuse assessments for unchanged sessions and reconsider the day’s clusters, since new evidence can identify previously unassigned work. Session records are keyed by the day's summary and prompts only, so a session that continues on a later day does not make an earlier report stale.
- Generate on demand and nightly. After 00:30 the background server generates the previous day's report, catching up to three days after sleep or downtime. It covers days with activity and no report, and refreshes once a report saved before its day ended that has since changed. `WORKLOG_NIGHTLY_REPORTS=off` disables it and `WORKLOG_NIGHTLY_REPORT_TIME` changes the time.
- OpenRouter receives bounded excerpts and project hints during explicit generation. Store the input tokens, output tokens, request count and cost returned by the API for each successful generation. Browsing sessions and reopening reports run locally.

## First-release review

Use the mixed-day examples above as acceptance cases. Have the engineer independently list the expected projects and main outcomes for one real day, then compare that list with the report. Look specifically for one project split across worktrees, unrelated projects merged by name, and a second task lost inside a mixed session. Check one overnight session and one unreadable session for date attribution and coverage. Verify the reading page and copied Markdown both make sense on their own, and that every claimed completion has supporting evidence in the underlying logs.
