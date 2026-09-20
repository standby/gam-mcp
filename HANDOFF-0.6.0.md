# gam-mcp 0.6.0 — shipped 2026-09-20

**0.6.0 is published.** `gam-mcp@0.6.0` is on npm and is `latest`; the `v0.6.0` tag and its
[release page](https://github.com/standby/gam_mcp/releases/tag/v0.6.0) point at `2075083`, which is
exactly the commit that was packed and published. `main` carries the 94-entry changelog.

All nine 0.6.0 branches are contained in the tag, verified by ancestry against the tagged commit:
`feat/0.6.0-report-path`, `feat/0.6.0-identity-cache`, `feat/0.6.0-inputs-http`,
`feat/0.6.0-smoke`, `feat/0.6.0-tool-correctness`, `feat/0.6.0-docs-release`, `release/0.6.0`,
`design/0.6.0`, `chore/0.6.0-npm-metadata`.

## What shipped

A correctness release for the analytics tools: the shared report path (create → poll → page →
decode), the report result cache, and the tool-input contract were rewritten. 122 commits,
985 tests, **18 breaking changes**, 27 added, 44 fixed, 5 changed.

Verified against a live network before release: auth, schema, entity reads, strict input rejection,
and create → poll → page → reuse (a second identical call returned `cache.hit: true` with the same
report, result and run time). Cost: one hidden report object, because the date range was pinned.

`docs/superpowers/RELEASE-NOTES-0.6.0.md` is the document to read beside the changelog — 32 of the
44 `fix:` entries repair code introduced earlier in this same unreleased stack, not defects any
published version had.

## Fix these before the next release

Everything that went wrong on release day traced to two settings, not to the code.

1. **Enable Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create
   and approve pull requests."** Without it release-please prepares a release, pushes the branch,
   then dies with *"GitHub Actions is not permitted to create or approve pull requests"* — which
   also crashes the action **before it tags**. This blocked the 0.5.3 attempt, blocked 0.6.0's
   release PR (opened by hand as #13), and then silently skipped tagging v0.6.0, which had to be
   created manually. It is the single highest-value fix in this file.
2. **Replace the expired `NPM_TOKEN` secret.** Created 2026-06-03; v0.5.1 published from CI on
   Aug 14, v0.5.2 and v0.6.0 both failed with `404 Not Found - PUT .../gam-mcp`, which is npm's
   way of saying unauthorized. A 90-day token minted June 3 expires around Sept 1, which lands
   exactly between the last success and the first failure. Until it is replaced, **publishing is a
   local `npm publish` from `main`** — and note `../gam_mcp-release` and the feature worktrees sit
   *before* the version bump, so publishing from one of them would ship the old version.

Also outstanding: the branch `release-please--branches--main--components--gam-mcp` holds a stray
0.7.0 prep commit that release-please pushed while it could not see the v0.6.0 release. Now that
the tag exists it should settle, but check it does not surface as a surprise PR.

## Where the records are

**The SDD ledgers are committed at `docs/superpowers/ledgers/`.** They hold every ruling and
deferred item from the five PRs, and were rescued from the per-task worktrees before those were
deleted — nothing else in them exists anywhere else.

They were generalised before being committed. As written they described the publisher-data scrub
*by naming what it removed* — the market, the placement name, the currency — and one carried a real
report ID. Each of those statements is true of any network, so it now reads that way: "the
publisher's zones were its own network zone and a different deployment zone", not the zone names.
The same pass caught a survivor the original scrub had missed entirely, in `tasks/pr5-scope.md`,
which was tracked. **That fix is a new commit; the string is still in history before it.** Rewriting
history again was not worth invalidating the published `v0.6.0` tag over a planning document in a
private repo — but it is a live decision if this repo is ever made public.

`tasks/lessons.md` holds the corrections worth keeping. `docs/superpowers/specs/` and
`docs/superpowers/plans/` hold the spec and the five plans.

## Next

**Port the GA4 and GAM MCP servers into `~/workspace/ask-data-agent`** — the request
that started this work. Known inputs: a `GAM_TIMEZONE` that differs from the network's own zone
(deliberate, must keep working — and verified working, because the two zones share a UTC offset, so
no divergence warning fires); `GAM_REPORT_TIMEOUT_MS` below that client's 120 s; bearer token as
`${GAM_MCP_TOKEN}`; `describe_line_item` treated as sensitive.

Spec §9 holds the 0.6.0 follow-ups: a per-request GAM timeout, a `date_range` input and structured
`listed`/`excluded` counts for `find_unused_ad_units`, `AdUnit.hasChildren` confirmation, and the
`derived.value` semantic ambiguity.

## The one operational fact a publisher needs

Running a report tool **defines a report object in the customer's GAM network**. The REST API
creates it `HIDDEN` and offers **no delete**. Reports are named after their definition hash, so
identical queries reuse one — but **the resolved date range is part of that hash**, so a rolling
window mints a new report every day. **Four tools cannot be pinned at all**: `find_unused_ad_units`,
`diagnose_fill_rate` and `diagnose_floor_pricing` take only `lookback_days`; `find_anomalies` takes
no window input and hardcodes seven days. Each defines a fresh, undeletable report on every calendar
day it runs. Documented in the README, spec §9 and the release notes.

## Rules learned the hard way

1. **No AI attribution anywhere** — commits *and* PR bodies. Scan before every commit.
2. **Never type a `\u` escape into an Edit/Write tool argument.** Tool arguments are JSON, so it
   decodes into a raw control byte. Use `python3` with `chr()`.
3. **Verify self-reported deviations.** Several implementer reports made claims that did not
   survive a grep.
4. **Absence is not permission.** The recurring defect class: `Number('') === 0`, `?? ''`, an empty
   array satisfying `every()`. Decide explicitly what nothing means.
5. **Mutation-test every assertion that matters.** A mutation that does not fail is a finding.
6. **A `BREAKING CHANGE:` footer is release-facing text.** Check every claim against the diff.
7. **A tool description is the LLM's only documentation.** `compare_periods` promised `null` and
   returned `''` for a year.
8. **A case-insensitive grep will fool you.** `gam_service_account` "appearing" in the README was
   the env var `GAM_SERVICE_ACCOUNT_KEY_FILE`. Scan case-sensitively, then read the hits.
9. **Scrub prose, not just identifiers.** The first scrub pass matched variable names and missed
   the comments describing them.
