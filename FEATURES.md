# Feature documentation — vercel-cleanup-tui

This is the full feature list for the tool as shipped in v0.1.0.
If a feature is not listed here, it is not in the tool yet.

## What the tool is

An interactive terminal (TUI) tool that cleans up old Vercel
deployments. It runs on Windows and Linux, in PowerShell, Command
Prompt, VS Code's terminal, macOS Terminal, and Linux terminals —
anywhere the Vercel CLI runs. It needs Node.js 20.17+ and the Vercel
CLI, already logged in with `vercel login`.

## Feature list

### 1. No token, no server, no hosting
- The tool never asks for a Vercel API token.
- It never stores a token, and never sends data to any server.
- It only shells out to the `vercel` CLI already logged in on the
  user's own machine.
- The author has nothing to host and nothing to see. All data stays
  on the user's PC.

### 2. Login preflight check
- Before doing anything, the tool runs `vercel whoami`.
- If the CLI is not logged in, it stops and tells the user to run
  `vercel login` first. Nothing else runs.

### 3. Project selection
- Pass the project as an argument (`vercel-cleanup my-project`),
  with `--project my-project`, or type it when prompted.
- Optional `--scope <team-slug>` for Vercel teams.

### 4. Full deployment listing with pagination
- Lists deployments with `vercel ls <project> --json --limit 100`.
- Pages through `--next` (timestamp of the last deployment) until
  every deployment is listed, not just the first page.
- Never parses the `vercel ls` text table. When piped, that table
  goes to stderr and a bare URL list goes to stdout, which corrupts
  table parsing. JSON and epoch-millisecond ages only.

### 5. Deployment details shown for every row
- Deployment URL
- Environment: Production or Preview (from `target`)
- State: READY, BUILDING, QUEUED, INITIALIZING, ERROR, CANCELED,
  BLOCKED, and anything else the CLI returns
- Age, computed from epoch milliseconds, shown as minutes, hours,
  or days (for example `45m`, `9h`, `18.0d`)
- Git branch and short commit SHA, when the CLI returns them in
  deployment metadata

### 6. Current-production protection (always on)
- The newest READY production deployment is identified and shown
  as protected.
- It is never offered in the checkbox list, so it cannot be
  ticked by mistake.
- Older production deployments *can* be selected deliberately —
  deleting one removes that rollback target, so the user must tick
  it on purpose.
- If no READY production deployment is found, the tool warns that
  nothing is auto-protected.

### 7. Filters before selection
Choose one filter, then tick from the filtered list:
- All (except current production)
- Older than 7 days
- Older than 30 days
- Preview only
- Failed / canceled only (ERROR, CANCELED, BLOCKED)
- Custom age in days (typed number, must be greater than 0)

Filtered candidates are shown oldest first, in deletion order.

### 8. Interactive checkbox selection (no command typing)
- Arrow keys move, Space ticks/unticks, `a` toggles all,
  Enter confirms the selection.
- Nothing is pre-ticked. Bulk selection is deliberate: press `a`.
- The list pages 15 rows at a time.
- An empty selection stops the run. Nothing is deleted.

### 9. Summary before any deletion
- Selected count, counts by state, and every selected URL with
  its environment, state, age, branch, and commit.
- `--dry-run` stops here: it lists what would be deleted and
  deletes nothing.

### 10. Two-step confirmation
- A checkbox selection alone never deletes anything.
- A separate confirm prompt follows (default: no). Answering no
  cancels the run and deletes nothing.

### 11. Fresh re-check guard (anti-race)
- After confirmation, the deployment list is fetched fresh.
- If the current production deployment changed since selection,
  the whole run aborts and deletes nothing.
- Selected URLs that no longer exist (for example, removed by
  Vercel's retention policy in the meantime) are skipped, not
  re-deleted.

### 12. Batch deletion by URL only
- Deletion runs in batches of 20, with
  `vercel remove <url-1> … <url-20> --yes`.
- Only deployment URLs are ever passed to `vercel remove`.
- The project name is never passed to `vercel remove`, because
  that form deletes the whole project.
- If a batch fails, the run continues with later batches, reports
  the failed URLs at the end, and tells the user to re-list before
  retrying — a batch can delete some deployments server-side even
  when its confirmation output never arrives, so a failed batch
  must never be assumed to have deleted nothing.

### 13. Clear end-of-run report
- Deleted count and failed count.
- Failed URLs listed individually.
- Exit code 1 if any batch failed, so scripts can detect it.

### 14. Demo mode (preview and screenshots, no login)
- `vercel-cleanup --demo` runs the full interactive flow on
  sample data: 8 deployments covering current production, old
  production, previews, ERROR, and CANCELED, across minutes to
  45 days.
- No Vercel login is needed in demo mode, and nothing is ever
  deleted. After confirmation it prints what *would* have been
  deleted and stops.
- Demo mode exists so anyone can preview the tool, and so
  screenshots can be taken without a real Vercel account.
- Screenshots in `docs/screenshots/` are demo-mode screenshots
  and are labelled as such. They show sample URLs, not a real
  account's deployments.

### 15. Safe cancellation
- Ctrl+C / Escape at any prompt cancels the run cleanly with
  "Cancelled. Nothing deleted."
- Running the tool with piped (non-terminal) input refuses to
  run, instead of guessing at prompts.

### 16. Cross-platform, single codebase
- One Node.js codebase for Windows and Linux.
- On Windows, the Vercel shim (`vercel.cmd`) is run through a
  shell; everywhere else, arguments are passed exactly, with no
  shell, so a project name cannot inject a command.

## Screenshots

Demo-mode screenshots (sample data only, no real account):

- `docs/screenshots/01-filter.png` — filter selection
- `docs/screenshots/02-checkbox.png` — checkbox selection
- `docs/screenshots/03-summary-confirm.png` — summary and confirm
- `docs/screenshots/04-demo-result.png` — demo result

Real-account screenshots can replace these later: run the tool
with a real login, take screenshots of the same four steps, and
swap the files. No code change is needed for that.

## Deliberately NOT in v0.1.0

- No GUI / web app. CLI first, by design.
- No project dropdown. The project name is typed or passed as an
  argument. (The Vercel docs page for listing projects returned
  404 when checked, so no verified projects-list command was
  baked into v0.1.0.)
- No Netlify support. Vercel only.
- No automatic retention-policy setting. Vercel's own Project
  Settings > Deployment Retention already does that, and this
  tool does not change project settings.
- No restore / rollback. Vercel does not restore deleted
  deployments, and this tool cannot either.
- No token mode. If a future version adds API-token support, it
  must be a separate, explicit mode — the default stays
  CLI-login-only, so the token question never arises for
  ordinary users.
- No telemetry, analytics, or update checks. The tool makes no
  network calls of its own at all.

## Requirements recap

- Node.js 20.17+ (22 / 24 also work)
- Vercel CLI installed and logged in (`npm install -g vercel`,
  `vercel login`) — except in `--demo` mode, which needs neither
