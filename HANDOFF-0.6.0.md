# gam-mcp 0.6.0 — handoff (updated 2026-09-19)

Resume in **`~/workspace/gam_mcp`** (branch `design/0.6.0`). Read this file, then
`docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md` (the binding spec) and
`docs/superpowers/plans/2026-09-17-gam-mcp-0.6.0-index.md` (the plan index).

**Nothing is merged to `main`.** Published version is still `0.5.2`; release-please cuts 0.6.0 when
the stack lands on `main`.

## State

| PR | Branch | Worktree | Head | Base | State |
|----|--------|----------|------|------|-------|
| [#7](https://github.com/standby/gam_mcp/pull/7) | `feat/0.6.0-report-path` | `../gam_mcp-0.6.0-pr1` | `7f6a7e3` | `main` | reviewed, awaiting merge |
| [#8](https://github.com/standby/gam_mcp/pull/8) | `feat/0.6.0-identity-cache` | `../gam_mcp-0.6.0-pr2` | `6f3cbc8` | #7 | reviewed, awaiting merge |
| [#9](https://github.com/standby/gam_mcp/pull/9) | `feat/0.6.0-inputs-http` | `../gam_mcp-0.6.0-pr3` | `3620d1b` | #8 | reviewed, awaiting merge |
| [#10](https://github.com/standby/gam_mcp/pull/10) | `feat/0.6.0-smoke` | `../gam_mcp-0.6.0-smoke` | `0ea54e7` local / `68cf575` pushed | #9 | **diverged — see warning** |
| — | `feat/0.6.0-tool-correctness` | `../gam_mcp-0.6.0-pr4` | `0ea54e7` | was #10 | done, merged locally into `feat/0.6.0-smoke`, **no PR** |

`design/0.6.0` is at `d39c1da`.

### ⚠️ `feat/0.6.0-smoke` is 20 commits ahead of its remote, and they are all PR 4's

PR 4 was merged into it **locally** (fast-forward). `origin/feat/0.6.0-smoke` is still at `68cf575`,
so PR #10 on GitHub is still just the smoke script. **Pushing that branch would silently turn PR #10
into "smoke script + all of PR 4".** Decide first:

- want PR 4 reviewed on its own → reset `feat/0.6.0-smoke` to `68cf575`, push
  `feat/0.6.0-tool-correctness` and open a PR stacked on #10; or
- happy to fold it in → push, and retitle/rewrite #10's body to cover both.

## Done since the last handoff

**PR 4 — tool correctness (spec §4 in full, plus §1.4, §1.5, §1.2's unlimited-end rule).**
Nine tasks, 20 commits, **979 tests** (from 907). Typecheck, build, `verify:pack` clean. Final
whole-branch review on the strongest model returned NOT READY with three findings; all fixed and
re-reviewed clean. Highlights: `top_n` actually sorts and caps; every computed field moved under
`derived` with `method`/`heuristic`/`inputs`; `numOr0`/`pctOrZero`/`Number(x)||0` genuinely gone
(26 sites, verified branch-wide, four deliberate survivors documented); 11 tools group by ID as well
as name and `compare_periods` refuses a duplicated join key; pacing reports GAM's delivery indicator
and works on the 1st of the month; a failed `health_check` is now an error.

**Private-data scrub (owner decision, categorical).** The network code, two report ids, two result
ids, the network's real time zone/currency and the owner's deployment zone were removed from **all
75 stack commits** and from `design/0.6.0`'s two, by content rewrite — not a tip-only commit, which
would have left every branch HEAD dirty. Fixtures now use `Asia/Tokyo`/`Asia/Seoul` (chosen: two
distinct zones sharing a UTC offset with no DST, which `zones.test.ts` depends on) and `USD`/`EUR`.
Backups and `refs/original/*` deleted; `chore/0.6.0-scrub` deleted local+remote. **No recovery path
exists.** Anyone with an older clone must re-clone.

**Live transports smoke, run 2026-09-19 on the merged branch: SMOKE OK.** It reused the *same*
report (`reports/1234567890`) on both transports — proof PR 4 did not move `run_report`'s definition
hash despite changing 11 tools' dimension lists and adding `sorts`/`describesFilters`. No cache
orphaning, no new hidden report.

## Do these next

### 1. Decide the `feat/0.6.0-smoke` divergence (above). Blocks pushing anything.

### 2. The one parked residual — ~4 lines

`compare_periods` rows carry **two missing-data sentinels**: `''` for raw `<metric>`/`<metric>_prev`,
`null` for the computed `<metric>_delta_pct.value`. Not a §1.4 violation (raw passthroughs are not
computed fields) and nothing downstream misreads it, but every other §1.4 tool uses `null`.
Recommended: take it.

### 3. PR 5 — docs and release

**Scope is already written: `tasks/pr5-scope.md` (513 lines).** It is much bigger than the original
handoff implied — PRs 1–3 touched exactly one README hunk, so everything above `README.md:198` is
0.5.2 prose and wrong in about seven places (`GAM_TIMEZONE` default, `GAM_INLINE_ROW_THRESHOLD`
spooling, three cache claims, the `gam://network` shape, the tool count, an example using
`month_to_date` which now errors on the 1st).

Release notes are the delicate part:
- **Nine commits across PRs 1–3 carry `BREAKING CHANGE:` footers** and release-please surfaces those
  itself. **PR 4 adds six more.** All are reproduced verbatim in the PR bodies of #7/#8/#9 —
  **a squash merge collapses the commits, so the PR body is the only copy release-please sees.**
- Several breaking changes carry **no** footer and need hand-written notes: offset time zones now
  refused; tool-input strictness split across two footers, neither saying "every tool";
  `AMBIGUOUS_NAME` turning working name lookups into errors; the new 1 MiB HTTP body limit; and that
  the server writes hidden, undeletable report objects into the network on every report call.
- 30 `fix:` commits, of which **19 repair code written earlier in this same unreleased stack**.
  `release-please-config.json` is not on defaults (`refactor` maps to a visible section), so the
  CHANGELOG lands at ~56 bullets, most of them noise about bugs no released version had.

Carried into PR 5 from PR 4's review: README's `describe_line_item` sensitivity note (§4.7's last
bullet); the `derived.value` semantic ambiguity plus `verdict`-flat-vs-nested asymmetry (one spec
clarification); kv_report's page-1-vs-page-2 filter wording; a smoke-script line exercising
`find_unused_ad_units` live (its `AdUnit.status` field name is as unprobed as `hasChildren` was —
if wrong the tool returns zero rows, loudly); `unknownZoneWarning`'s wording at `src/zones.ts`
(note: the file is 139 lines, the old "~168" was stale) — and `tests/report-zones.test.ts` asserts
that string verbatim, so it moves with it.

### 4. Merge the stack, then release

### 5. After 0.6.0 — the original request

Port the GA4 and GAM MCP servers into `~/workspace/ask-data-agent`. Known inputs: a
`GAM_TIMEZONE` that differs from the network's own zone (deliberate, must keep working);
`GAM_REPORT_TIMEOUT_MS` below that client's 120 s; bearer token as `${GAM_MCP_TOKEN}`;
`describe_line_item` treated as sensitive.

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
