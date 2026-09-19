# gam-mcp 0.6.0 — release notes

`release-please` writes the changelog for this release from commit subjects. This
document covers what it can't see: which of the changelog's `fix:` entries are
worth a user's attention, the breaking changes that carry no `BREAKING CHANGE:`
footer, and what a 0.5.2 upgrader is most likely to trip over.

## What 0.6.0 is

A correctness release for the analytics tools: the shared report path (create →
poll → page → decode), the report result cache, and the tool-input contract were
rewritten in this release, and most of the fixes below are fixes to that new code
— not defects any published version had.

Counted directly: of the 43 `fix:` commits in `main..HEAD`, **32 repair code
introduced earlier in this same unreleased stack** (identified by checking, for
each `fix:` commit, whether the file it touches did not exist on `main` at all, or
— where the file did pre-exist — whether the specific function/feature it patches
was itself added by an earlier `feat:`/`fix:` commit within `main..HEAD`, confirmed
by diffing against `main`'s version of that file or by an explicit reference in the
commit body to earlier work in this release, e.g. "Task 4 fix round 1"). The other
**11 fix real, pre-0.6.0 behaviour**: `find_unused_ad_units` flagging archived and
parent ad units as unused, `health_check` misclassifying a 404 and returning
`status: "failed"` as a success envelope, credential-library error text leaking
into logs, `kv_report`'s summary doubling a filter clause, dimension aliases not
being resolved in filter fields, a silently-resolved ambiguous name, an offset-form
`GAM_TIMEZONE` being accepted at all, and tool-returned error envelopes missing
`isError`. Several of those 11 are also 0.6.0 breaking changes — fixing a
published defect and breaking compatibility with callers who depended on the old
(wrong) behaviour are not mutually exclusive.

`release-please-config.json` maps `refactor` to a visible "Changed" section (not
the tool's default), so the generated changelog will show roughly `fix` (43) +
`feat` (27) + `refactor` (5) ≈ **75 entries** — long, and about three-quarters
of the `fix:` entries are this release fixing itself.

## Breaking changes release-please will show you

Eighteen commits in this release carry a `BREAKING CHANGE:` footer, and
`release-please` surfaces each one verbatim in the generated changelog. Two are
easy to misread in isolation:

- **`fix(find-unused-ad-units): only active, leaf ad units can be flagged as
  unused`** reads like a minor filtering tweak. It silently narrows the row set:
  archived ad units and parent containers that the tool previously (incorrectly)
  reported as "unused" no longer appear at all.
- **`feat(tools)!: group by entity id beside the name, and refuse a duplicated
  join`** changes the *definition hash* for eleven report tools (an ID column is
  added to each). The first call to any of those tools after upgrading defines a
  new report, not a reused one — expected, but easy to mistake for a caching
  regression if you're not expecting it.

The rest are accurately summarized by their own footer text; this document does
not repeat them.

## Breaking changes release-please will miss

Some of these carry no `BREAKING CHANGE:` footer at all — either because the
commit predates the footer convention taking hold, because the change is a
config-time behaviour change rather than a code diff, or because two footers
each cover only part of a wider change; a squash-merged changelog omits every
one of those. The `health_check` and `compare_periods` entries below are
different: their commits do carry a footer, and they're included here anyway
because they're easy to miss or to conflate with the footerless changes
around them.

### Offset-form `GAM_TIMEZONE` now refuses to start

`GAM_TIMEZONE=+08:00` worked on 0.5.2 — Node's `Intl.DateTimeFormat` accepts a raw
UTC offset as a `timeZone` value. `src/zones.ts`'s `canonicalTimeZone()` now
rejects anything `Intl` resolves to a string starting with `+` or `-`, and
`src/startup.ts`'s `readSettings()` turns that into `{ error }`; `src/cli.ts`
exits with code 2 before the credential is even used. `Etc/GMT-8` and similar
**stay accepted** — they're spelled with a leading letter, so `Intl` treats them
as IANA names, not offsets. (Commit `c5f31b2`; verified in `src/zones.ts` and
`src/startup.ts:47-52`.)

**What to do:** replace any offset-form `GAM_TIMEZONE` with the equivalent IANA
zone name (for example `Asia/Seoul`, not `+09:00`) — the same example
`src/startup.ts`'s own error message uses.

### Every tool input is strict — for all tools, not some

`feat!: refuse unknown tool arguments and describe every field` (`57f7fb5`) added
the mechanism; `feat: advertise each tool input in full and name what is wrong
with an input` (`cf241aa`) added the per-field descriptions. Between the two, only
`57f7fb5` carries a `BREAKING CHANGE:` footer, and it reads as "a tool" (singular)
rather than stating the scope. In the shipped code this is universal: **34** of
the `.strict()`-declared schemas live in `src/tools/*.ts`, plus **3** more in the
shared `filterInput`/`dateRangeInput` building blocks in `src/tool-input.ts`
that tool schemas compose from, and every one of the **33** tools actually
registered (`src/tools/index.ts`) is parsed through one shared path in
`src/server.ts` (`tool.input.safeParse(...)`), which rejects an undeclared key
anywhere in the input — including inside a nested object such as `date_range`
— as `INVALID_INPUT`, naming the offending key via `describeInputError()` in
`src/tool-input.ts`. There is no tool that still drops unknown keys silently.

**What to do:** audit any caller that has been passing extra, previously-ignored
fields (typos, deprecated aliases, speculative fields) to any `gam-mcp` tool —
every one of them now errors instead of ignoring the extra key.

### `AMBIGUOUS_NAME` replaces a silent first match

Before this release, a custom-targeting-key or ad-unit name that matched more
than one entity was silently resolved to the first match GAM returned. Commit
`31191e5` (`fix: report a key or ad unit name that matches more than one entity`)
makes that an error instead: `src/kv-rewrite.ts` now returns
`gamError('AMBIGUOUS_NAME', { entity_type, query, candidates, hint })` wherever a
name-to-ID lookup finds more than one candidate. This ships without a
`BREAKING CHANGE:` footer.

**What to do:** a query that worked under 0.5.2 by resolving to "whichever entity
GAM listed first" now needs a name specific enough to be unambiguous, or needs to
look the candidates up first.

### A 1 MiB HTTP body limit, refused with 413

`src/http-transport.ts` defines `MAX_BODY_BYTES = 1024 * 1024` and refuses any
request body over that with HTTP 413, whether declared via `Content-Length` or
discovered while streaming. This first shipped as part of
`feat: guard the HTTP endpoint with a bearer token, a host list and a body limit`
(`cde498d`), with two follow-up `fix(http)` commits (`71283e4`, `2e46e8a`) closing
connection-handling gaps in the same code — none of the three carries a
`BREAKING CHANGE:` footer, and the limit only applies in HTTP mode.

**What to do:** callers running `gam-mcp` over HTTP with large tool-call payloads
(long `IN` filter lists, wide custom-dimension slot maps) need to stay under 1
MiB or expect a 413.

### `health_check` fails as an error, not a success envelope

0.5.2's `health_check` returned a normal (non-`isError`) result whose first row
carried `status: "failed"` when the probe failed. Two commits change this:
`cd23a81` (`fix(tools)!: a failed health check is an error, and summaries name
their filters`) and `e0f3ea52` (`fix(health-check)!: classify a confirmed 404 as
ENTITY_NOT_FOUND`) — both carry footers, but a squash-merged PR body that drops
footers loses this along with the rest. Verified in `src/tools/health_check.ts`:
the success path returns `listEnvelope([{ status: 'ok', ... }], ...)`, the
failure path returns `gamError(code, { check: 'listEntities', ... })` directly —
there is no longer a code path that returns a successful envelope describing a
failure.

**What to do:** callers parsing `health_check`'s result for a `status` field must
instead check `isError` / `error.code`.

### `compare_periods` returns `null`, not `''`, for a missing metric

This PR's own commit `18a6ad7` (`fix(compare-periods)!: one sentinel for a
missing value, not two`): a metric absent from one of the two compared periods
used to appear as `''` (empty string) in `<metric>` / `<metric>_prev`, while the
paired `<metric>_delta_pct.value` used `null` for the same absence — two
sentinels for one condition. Both now read `null`. This one does carry a footer;
it's listed here because it's easy to conflate with the footerless changes above
and because it's the most recent commit in the stack.

**What to do:** any caller doing `row[metric] === ''` to detect a missing value
needs `row[metric] === null` instead.

### Report objects: hidden, and there is no delete

Not a code change in this release — a structural fact about how `gam-mcp` talks
to GAM that a 0.5.2 user upgrading deserves to read once. Running any report tool
defines a report in the customer's GAM network (`src/gam-client-rest.ts`'s
`defineReport()`), named after the SHA-256 of its canonical definition
(`src/report-key.ts`). `visibility` is left unset, which is GAM's default,
`HIDDEN` — the report stays out of the Ad Manager UI, but it exists as a resource
in the network. **There is no delete.** No file in this codebase calls a reports
delete endpoint; `gam-mcp` has no tool, and the underlying client has no method,
that removes a report it created. Every distinct report shape a caller ever asks
for accumulates as a hidden object in the network, for the life of the network.

## The accumulation story

A report is named after the hash of its definition (`src/report-key.ts`,
`definitionHash()` / `reportName()`), so two calls that ask the same question —
same dimensions, metrics, filters, **and date range** — reuse one report. That's
the intended behaviour, and it's why most tools, which take an explicit
`date_range`, define at most one report per distinct query shape.

**But the resolved date range is part of the definition that gets hashed.**
`src/report-definition.ts` makes `dateRange: { fixed: { startDate, endDate } }` a
required field of `ReportDefinition`, and `canonicalDefinition()` in
`src/report-key.ts` serializes every field of the definition except
`undefined`/`null`/empty-array — `dateRange` is never excluded. A tool whose date
range is a rolling window relative to "now" therefore resolves to a different
`dateRange` every calendar day, which produces a different hash, which produces a
different report name, which defines a **new** hidden report — on top of, not in
place of, yesterday's.

**Four tools cannot be pinned to a fixed window at all**, verified directly in
`src/tools/*.ts`:

- `find_unused_ad_units` — `lookback_days: z.number()...default(30)`, no
  `date_range` field in its `.strict()` input schema.
- `diagnose_fill_rate` — `lookback_days` only, default 7.
- `diagnose_floor_pricing` — `lookback_days` only, default 7.
- `find_anomalies` — **no window input whatsoever**; its input schema has no
  `lookback_days` or `date_range` field, and `pacing_underdelivery` /
  `week_over_week` both call `lastDays(7, ctx.timezone, ctx.now)` directly.

All four resolve their window with `lastDays(N, …, ctx.now)`, reach GAM through
the same `executeReportRows` → `definitionHash` path as every other report tool,
and therefore define a fresh, hidden, undeletable report **every calendar day
they run** — not once at startup, not once per distinct query, but once per day,
forever, for as long as the network exists. This is why PR 5's smoke check had to
gate `find_unused_ad_units` behind its own opt-in flag instead of running it
alongside the rest of the smoke suite (commits `b726972`, `a64cbbe`): it's the
one problem shared by all four tools, not a quirk of that tool alone. An earlier
draft of the design spec described this as affecting a single tool; that was
wrong, and §9 of `docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md` now
records the corrected, all-four-tools version. This document is consistent with
that correction.

**What to do:** if report accumulation in your network is a concern, avoid
calling these four tools on a recurring schedule (e.g. a daily cron), or budget
for one new hidden report per tool per day it runs.

## What a 0.5.2 upgrader is most likely to be surprised by

Ranked most surprising first:

1. **The hidden report objects accumulating without limit**, especially via the
   four wall-clock-window tools above — nothing in a normal tool response
   signals that this is happening.
2. **Six new conditions that stop startup with exit code 2**, where 0.5.2
   started successfully: the credential failing to read the network identity
   (`checkNetworkIdentity`, was previously deferred to first use); a `GAM_TIMEZONE`
   that isn't a valid IANA zone name; a non-numeric `GAM_NETWORK_CODE`; a
   `GAM_REPORT_TIMEOUT_MS` that isn't a positive whole number; a
   `GAM_REPORT_CACHE_TTL_MS` that isn't a non-negative whole number; and a
   `GAM_REPORT_CACHE_DIR` that can't be created. (HTTP mode adds one more: a
   non-digits `GAM_HTTP_PORT`, and a busy port now fails cleanly instead of
   crashing. `GAM_PAGE_ROWS` is checked unconditionally, before the stdio/HTTP
   branch in `src/cli.ts`, so a bad value stops startup in stdio mode too —
   it is not HTTP-only.) All verified in `src/startup.ts` and `src/cli.ts`'s
   `main()`.
3. **Unset `GAM_TIMEZONE` now means the network's zone, not UTC** — spec §6 item
   8. A caller that never set `GAM_TIMEZONE` and relied on "yesterday" meaning
   UTC-yesterday will see that date move if the network's zone differs from UTC.
4. **`AMBIGUOUS_NAME` turning previously-working queries into errors** — a name
   that happened to resolve to the right entity by luck (first match) now needs
   to be disambiguated.
5. **Local report-query validation** rejecting combinations GAM would have
   refused anyway (impossible dates, an end date after yesterday, period-to-date
   ranges on their first day) — mostly a wash, but the error now arrives before
   any GAM call rather than from GAM itself, which changes what the error message
   looks like.

## For whoever merges the release PR

`release-please` builds its changelog entry from commit messages **at release
time**, by reading the commits reachable from the PR. After a **squash merge**,
GitHub collapses the entire PR into one commit whose message is the PR
description — the individual commits, and every `BREAKING CHANGE:` footer they
carried, are gone from history. **The PR body is the only copy `release-please`
will ever see.** All 18 `BREAKING CHANGE:` footers from this stack must be
present in the release PR's description, or they are lost from the changelog
permanently.

A **merge commit** (not squash, not rebase) preserves every commit and its
footers in history, and needs no special handling here.

If this is squash-merged, copy every `BREAKING CHANGE:` footer listed under
"Breaking changes release-please will show you" above, verbatim, into the PR
body before merging.
