# Daily report

Product design draft for the macOS desktop dashboard.

## Reader and purpose

The primary reader is the engineer returning to yesterday's work. In about 30 seconds they should recognize the projects they worked on, recall what moved forward in each, and see any questions explicitly left open. Worklog discovers those projects from the day's activity. The reader can generate a report without naming projects, assigning sessions or configuring folder rules.

## Reading experience

In **By date**, replace the existing **Daily summary** disclosure with a **Daily report** action in the same right-hand rail. Selecting it opens a wide desktop drawer. Keeping the selected date and scroll position makes it easy to return to the session list. The report belongs to the entire local calendar day. Its header shows the date, time zone and “All projects and agents” even when a search or harness filter is active. Keep the entry accessible when filters hide all sessions on an otherwise active day.

On first use, select **Generate report** in the drawer. Show progress as sessions analyzed out of the day's total. Once saved, opening the drawer goes straight to the report. If new activity arrives, keep the previous version readable and offer **Update report**. A failed update preserves the saved version. A day with zero sessions gets a short empty state.

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

Give each project with substantive work a heading and typically one to three short bullets. Lead with the change, finding or decision. Include an open question only when someone raised it and the day's record leaves it open. Omit greetings and setup chatter. The drawer and **Copy Markdown** both present a standalone report in the same order. Session identifiers, footnotes and links are omitted from both.

## How projects are discovered

A project is a recognizable body of work, such as Worklog or Ponsu. Each heading answers “what was I working on?” and the bullets under it answer “what happened there?” The same project can span several worktrees, checkouts, harnesses and tasks. An explicitly named research effort can also be a project without a repository. Prefer the most specific project name supported by the actual work. A broad product name shared by several independently maintained repositories is weak evidence for merging them.

### Report generation

Call OpenRouter directly on demand using Gemini 4 Hydrogen. A report creates no harness session. Use ordinary code for dates, repository identity and counts. Give the model two bounded jobs: interpreting a conversation and comparing the resulting work across the day.

1. **Collect the day's evidence.** For each session, collect the day's user requests, substantive replies, observed edits and tool outcomes. Where available, attach the repository of the files actually worked on, its normalized remote identity, and the repository owning a linked PR or issue. A Git common directory can identify sibling worktrees locally. Treat current checkout metadata as a hint when reconstructing older activity.
2. **Extract work from each session independently.** Produce one or more short records containing the task, observed outcome or open question, candidate project and facts supporting that association. Split when the user moves to a different deliverable or project. A mention made for comparison does not create another record. Each record retains its originating evidence internally for validation.
3. **Cluster the records across all three harnesses.** Start with strong associations such as edits in worktrees of the same repository or an explicit review request naming a repository's PR. Use the clustering request to resolve generic directories, alternate names and work without a repository using the task and its deliverable. Combine different repositories under a named initiative only when the records explicitly establish that shared project. A folder basename, timestamp, generic keyword or bare issue number is insufficient on its own. Put substantive work with an unresolved owner under **Other work**; avoid inventing a project name.
4. **Write and check the report.** Within each project, consolidate records that describe the same task and retain distinct deliverables as separate bullets. Emit each piece of work once. Check the project assignment and outcome wording against its supporting records before rendering. Discard unsupported claims and count failed analyses in the coverage indicator.

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
- Store the report and internal assessments locally, separately from source logs. Reopening a saved report makes no model call. On update, reuse assessments for unchanged sessions and reconsider the day’s clusters, since new evidence can identify previously unassigned work. Keep generation on demand in the first release.
- OpenRouter receives bounded excerpts and project hints during explicit generation. Store the input tokens, output tokens, request count and cost returned by the API for each successful generation. Browsing sessions and reopening reports run locally.

## First-release review

Use the mixed-day examples above as acceptance cases. Have the engineer independently list the expected projects and main outcomes for one real day, then compare that list with the report. Look specifically for one project split across worktrees, unrelated projects merged by name, and a second task lost inside a mixed session. Check one overnight session and one unreadable session for date attribution and coverage. Verify the drawer and copied Markdown both make sense on their own, and that every claimed completion has supporting evidence in the underlying logs.
