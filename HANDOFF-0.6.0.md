# gam-mcp 0.6.0 — handoff (updated 2026-09-19)

**0.6.0 is feature-complete on `release/0.6.0`.** All five PRs are merged into that one branch,
122 commits ahead of `main`, carrying **18 `BREAKING CHANGE:` footers**. 985 tests; `typecheck`,
`build` and `verify:pack` clean; the live transports smoke passed on the merged tree.

Resume in **`~/workspace/gam_mcp`**. `release/0.6.0` has a worktree at
`../gam_mcp-release`. Nothing is pushed — `origin/release/0.6.0` is 26 commits behind.

The binding documents are `docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md` (the spec)
and `docs/superpowers/RELEASE-NOTES-0.6.0.md` (what the changelog cannot say for itself).

## What is on the branch

| PR | Branch | What it did |
|----|--------|-------------|
| 1 | `feat/0.6.0-report-path` | typed report path, paging, `fetch_report_page` |
| 2 | `feat/0.6.0-identity-cache` | startup identity check, two-tier result cache, report reuse |
| 3 | `feat/0.6.0-inputs-http` | strict tool inputs, date rules, HTTP transport and its boundary |
| — | `feat/0.6.0-smoke` | `npm run smoke:transports` — drives `dist/cli.js` over stdio and HTTP |
| 4 | `feat/0.6.0-tool-correctness` | spec §4 in full — `top_n`, `derived` blocks, IDs beside names, pacing, heuristics |
| 5 | `feat/0.6.0-docs-release` | README rewrite, spec amendments, release notes, `CLAUDE.md`, two code fixes |

`design/0.6.0` (this file, `tasks/lessons.md`, the two scope documents) is merged in as well. The
publisher-data scrub is in every one of those commits — the network code, two report ids, two
result ids, the network's real zone and currency, and the owner's deployment zone are gone by
content rewrite. Backups and `refs/original/*` are deleted; **no recovery path exists**, so an
older clone must be re-cloned.

## Before merging to main — three things

1. **A squash merge loses 17 of the 18 breaking-change footers.** After a squash the PR body is
   the only copy release-please reads. `docs/superpowers/RELEASE-NOTES-0.6.0.md` carries a verified
   `awk` command that extracts all 18 — run it and paste the output into the PR body, or use a
   merge commit, which preserves them by itself.
2. **Several breaking changes carry no footer at all** and exist only in the release notes: offset
   time zones now refused, every tool input strict, `AMBIGUOUS_NAME` turning working name lookups
   into errors, the 1 MiB HTTP body limit, a failed `health_check` now an error, `compare_periods`
   returning `null` where it returned `''`, and the hidden report objects (below).
3. **32 of the 43 `fix:` commits repair code written earlier in this same unreleased stack**, not
   defects any published version had. Without that framing the ~75-entry changelog reads as 43
   user-visible bugs. The release notes say it; the CHANGELOG cannot.

## The one operational fact a publisher needs

Running a report tool **defines a report object in the customer's GAM network**. The REST API
creates it `HIDDEN` and offers **no delete**. Reports are named after their definition hash, so
identical queries reuse one — but **the resolved date range is part of that hash**, so a rolling
window mints a new report every day. **Four tools cannot be pinned at all**: `find_unused_ad_units`,
`diagnose_fill_rate` and `diagnose_floor_pricing` take only `lookback_days`; `find_anomalies` takes
no window input and hardcodes seven days. Each defines a fresh, undeletable report on every calendar
day it runs. This is in the README, spec §9 and the release notes. Giving those four a `date_range`
is a recorded post-0.6.0 follow-up.

## Do these next

1. **Push `release/0.6.0`** and open one PR against `main`, with the 18 footers in the body.
2. **Merge, let release-please cut 0.6.0**, then verify the published tarball (`npm run verify:pack`
   passes locally; check the npm page shows 29 shared + 4 saved-query tools, not 0.5.2's set).
3. **Then the original request:** port the GA4 and GAM MCP servers into
   `~/workspace/ask-data-agent`. Known inputs: a `GAM_TIMEZONE` that differs from the
   network's own zone (deliberate, must keep working); `GAM_REPORT_TIMEOUT_MS` below that client's
   120 s; bearer token as `${GAM_MCP_TOKEN}`; `describe_line_item` treated as sensitive.

Spec §9 holds the rest of the follow-ups: per-request GAM timeout, structured `listed`/`excluded`
counts on `find_unused_ad_units`, `AdUnit.hasChildren` confirmation, and the `derived.value`
semantic ambiguity.

## Where the records are

Each PR's SDD workspace survives at `<worktree>/.superpowers/sdd/<plan-basename>/progress.md` —
**read the ledger first; it holds every ruling and every deferred item.** PR 4's also records the
live-smoke result and four cases where the controller's own instructions were wrong.

`tasks/pr4-scope.md` and `tasks/pr5-scope.md` are the scoping outputs. `tasks/probe-0.6.ts` is the
live-probe script (now reads its report resources from the environment); keep it until 0.6.0 ships —
it is how a spec question gets an answer instead of a guess.

## Rules learned the hard way

1. **No AI attribution anywhere** — commits *and* PR bodies. One implementer added a footer by
   reflex and had to amend it out. Scan before every commit.
2. **Never type a `\u` escape into an Edit/Write tool argument.** Tool arguments are JSON, so it
   decodes into a raw control byte. Use `python3` with `chr()`.
3. **Verify self-reported deviations.** Four implementer reports on PR 4 made claims that did not
   survive a grep — including one that said `kv_report` was unaffected when it had a live regression.
4. **Absence is not permission.** The recurring defect class. `Number('') === 0`, `?? ''`, an empty
   array satisfying `every()`. Decide explicitly what nothing means.
5. **Mutation-test every assertion that matters.** Two mutations on PR 4 did *not* fail, and both
   times reporting that was the most useful thing in the report.
6. **A `BREAKING CHANGE:` footer is release-facing text.** Six on PR 4 needed correction, one
   because the controller asserted a false premise. Check every claim against the diff.
7. **A tool description is the LLM's only documentation.** `compare_periods` promised `null` and
   returned `''` for a year.
