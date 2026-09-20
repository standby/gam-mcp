# PR 4 — tool correctness: scope

**Written:** 2026-09-18. **Read against:** worktree `~/workspace/gam_mcp-0.6.0-pr3`,
branch `feat/0.6.0-inputs-http`, **HEAD `90dfe64`** (the handoff table says `e391ece`; one further
commit, `test(http): give the large-body cases room the default 10s does not leave`, has landed
since). Spec: `docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md`. Every line number below
is from that worktree.

Every behaviour claimed as "wrong today" in items 1, 2, 3b and 6 was **executed**, not inferred —
the built `dist/` was driven with the in-memory mock client. The transcripts are quoted inline.

PR 4 is spec **§4** plus the **§1.4 `derived` blocks** and tests **I1–I14** (plan index line 26).
Of the fourteen I-tests, **I4, I5, I8, I11, I14 already exist** (PR 3 ruling 3 took them); **I1, I2,
I3, I6, I7, I9, I10, I12, I13 do not**. **§4.4 is already done in full** — `inventory_breakdown`
asks for `REVENUE`/`IMPRESSIONS` (`src/tools/inventory_breakdown.ts:24`), the report path runs
`checkReportQuery` before GAM sees anything (`src/report-exec.ts:398-414`), and H3 exists and is
thorough (`tests/tool-requests.test.ts:54-80`). Nothing to do there; do not re-open it.

The handoff's six bullets are not six tasks. Bullet 3 ("IDs beside names; the heuristics; the
derived blocks; the I-series tests") is four separate pieces of work with a dependency between
them, and §4.5, §4.7 and the `DUPLICATE_JOIN_KEY` error code are in §4 but in none of the bullets.
Sections below are ordered by the sequence I recommend implementing them in; the handoff bullet each
one answers is named in its heading.

---

## 1. `top_n` is ignored by all seven report tools, and B1 stops covering `sorts`
*(handoff bullets 1a and 4 — spec §4.2, finding F1, tests I1 and B1)*

### What is wrong today

`buildReportTool`'s handler (`src/report-tool-builder.ts:101-117`) reads `input.date_range` and
calls `cfg.buildQuery(input)`. **It never reads `input.top_n`.** No tool's `buildQuery` sets a sort
either — `ReportQuery` (`src/gam-client.ts:30-42`) has no sort field, and `reportDefinition`
(`src/report-definition.ts:39-65`) emits no `sorts` key. `ReportDefinition.sorts` exists
(`src/report-definition.ts:16`) and `provenance.sort` reads it (`src/report-exec.ts:386`), but only
a definition *read back from GAM* can ever have one.

So `top_n` today changes exactly one thing: the wording of `summary`.

Executed — `top_advertisers({ top_n: 20 })` against a 46-row deliberately-unsorted fixture:

```
summary        : Top 20 advertisers by revenue, 2026-09-01..2026-09-16
total_row_count: 46
returned       : 46          <- asked for 20
truncated      : false
next_cursor    : null
sort provenance: []
first 5 REVENUE: [ 0, 101, 202, 303, 404 ]   <- ascending; the fixture order
```

The seven tools (spec line 15 names them): `top_advertisers`, `top_line_items`, `kv_breakdown`,
`bidder_breakdown`, `yield_breakdown`, `video_breakdown`, `viewability_breakdown`.

### What the spec says

§4.2 (line 283): "The seven tools in F1 put `sorts: [{ field: { metric }, descending: true }]` in
the definition and fetch only the first `top_n` rows. `summary` states the sort and 'N of
`total_row_count`'. The sort is part of the definition hash."

§1.1's worked example (lines 88-110) is literally this call: `"summary": "Top 20 advertisers by
revenue, 2026-09-01..2026-09-16 (20 of 46, sorted by REVENUE desc)"`, `total_row_count: 46`,
`returned_row_count: 20`, `truncated: false`, `next_cursor: null`,
`sort: [{ "field": { "metric": "REVENUE" }, "descending": true }]`. That settles the three open
questions: the cursor is **null**, `truncated` is **false**, and the summary names the sort metric.
§1.1 line 123 confirms: "`truncated` is `true` whenever `returned_row_count < total_row_count` for
any reason other than a requested `top_n`. `top_n` results state 'N of total' in `summary` and are
not marked truncated."

The probe proved GAM accepts it (spec line 71): `sorts: [{field: {metric: IMPRESSIONS}, descending:
true}]` → "Rows returned in descending order", and `reports.get` echoes it (line 70).

### Smallest change

1. `src/gam-client.ts` — `ReportQuery` gains `sort?: { metric: string; descending: boolean }`.
   Typed, not `unknown[]`: GAM's wire shape stays in `report-definition.ts`, as `toReportFilters`
   already does for filters (`src/report-definition.ts:94-106`).
2. `src/report-definition.ts` — `reportDefinition` maps that to
   `...(query.sort && { sorts: [{ field: { metric: query.sort.metric }, descending: query.sort.descending }] })`.
   It lands in the definition, so it is in the hash for free (`canonicalDefinition` iterates
   `Object.entries(def)`, `src/report-key.ts:49-57`) — which is what §4.2's last sentence requires.
3. `src/report-tool-builder.ts` — `ReportToolConfig` gains `topN?: (input) => number` and
   `sort?: (input) => { metric: string; descending: boolean }`; the handler passes `topN` on the
   `ReportRequest`.
4. `src/report-exec.ts` — `ReportRequest` gains `topN?: number`. When set, `executeReport` calls
   `firstPage(ctx, definition, req.topN, …)` instead of `pageRows(ctx)` (line 417), and
   `pageEnvelope` is told to suppress `next_cursor` and `truncated` and to append
   `" (N of TOTAL, sorted by METRIC desc)"` to the summary. **`top_n` must not reach the
   definition** — otherwise the result cache fragments per `top_n` and two calls differing only in
   `top_n` run two reports. A schema cap of 1,000 keeps one page under GAM's 10,000 limit, so no
   loop is needed.
5. The seven tools each add `topN: (i) => i.top_n` and a `sort`. Metric per tool: the one the caller
   picked for the three that have `metric` (`METRIC_MAP[input.metric]`); for the four breakdowns,
   the **first volume metric** in the existing list — `AD_EXCHANGE_REVENUE`
   (`src/tools/bidder_breakdown.ts:38-42`), `YIELD_GROUP_ESTIMATED_REVENUE`
   (`src/tools/yield_breakdown.ts:54-60`), `VIDEO_VIEWERSHIP_STARTS`
   (`src/tools/video_breakdown.ts:49-56`), `ACTIVE_VIEW_MEASURABLE_IMPRESSIONS`
   (`src/tools/viewability_breakdown.ts:49-55`). Never a `*_RATE`: ranking by a rate puts
   three-impression rows at the top. Because the summary now names the metric, the choice is
   visible to the caller rather than implied.
6. Each tool's `summary` drops its own hand-written "Top N"/"(top N)" text — the envelope appends
   the authoritative one.

### B1's fixture (handoff bullet 4)

`tests/report-key.test.ts:38-43` asserts the fixture carries *every* key a definition can have:

```js
expect(Object.keys(full()).sort()).toEqual([
  'currencyCode', 'customDimensionKeyIds', 'dateRange', 'dimensions', 'filters', 'metrics', 'reportType', 'timeZoneSource',
]);
```

**This assertion will not fail when `sorts` is added** — `QUERY` (line 10) sets no sort, so `full()`
keeps its eight keys. That is exactly why the item exists: the fixture silently stops meaning what
its test name says, and the `it.each(Object.keys(full()))` loop at line 44 silently stops covering
`sorts`. So: add `sort` to `QUERY`, add `'sorts'` to the expected key list, and add the **positional
test** the handoff asks for — sorts are ordered (primary, then tiebreak), so
`{ ...def, sorts: [...def.sorts].reverse() }` must change the hash, alongside the existing
`customDimensionKeyIds` positional test (line 98). `canonicalDefinition` passes any non-`filters`
array through untouched (`src/report-key.ts:53-54`), so this passes as written — the test pins that
it stays that way.

### Tests

**None exist.** `tests/tools/top_advertisers.test.ts:23` asserts `total_row_count === 2` on a 2-row
fixture and nothing else; the other six are the same shape. New `tests/tools/top_n.test.ts` (I1),
table-driven over the seven tools: each sends `sorts` with `descending: true` on its metric (assert
on the definition captured at `defineReport`, as `tests/tool-requests.test.ts:60-62` does), returns
exactly `top_n` rows from a fixture of `top_n + k`, and its summary matches `/\(\d+ of \d+, sorted
by [A-Z_]+ desc\)/`. Bite-check by mutation: drop the `pageSize` change and the row count goes
wrong; drop the sort and the assertion on the captured definition fails.

### User-visible

**Yes, and a behaviour change users will notice**: these seven tools currently return up to
`GAM_PAGE_ROWS` (5,000) unsorted rows and will return `top_n` (default 20–50) sorted ones. It is
the fix the tool always claimed to do, but it belongs in the release notes. `provenance.sort` stops
being `[]`. The definition hash changes, so the first call after upgrade creates a new GAM report
(HIDDEN, undeletable) per tool+shape — worth one line in the notes.

### Size / order

~270 lines across 13 source and 9 test files. **Do it first**: it is the largest single user-visible
defect, and it is the only item that touches `report-definition.ts` and `report-key.ts`, so it does
not collide with anything later.

---

## 2. Derived plumbing: `derived` blocks, null propagation, the total, and `DUPLICATE_JOIN_KEY`
*(handoff bullets 1b and 3 — spec §1.4, §1.5; foundation for sections 3, 4 and 5)*

### What is wrong today

**(a) The total is computed after `top_n`.** `derivedEnvelope` (`src/report-exec.ts:579-601`) sets
`total_row_count: d.rows.length` from the rows it is handed — and every caller hands it rows that
have already been sliced: `compare_periods.ts:69` (`sorted.slice(0, input.top_n)`) then `:74`;
`find_anomalies.ts:103`→`:108`, `:150`→`:155`, `:208`→`:213`, `:263`→`:268`;
`diagnose_fill_rate.ts:120`→`:125`; `diagnose_floor_pricing.ts:137`→`:143`. Executed —
`compare_periods` with `top_n: 1` over 3 joined keys:

```
summary        : Compare: … (3 keys, top_n=1)
total_row_count: 1      <- should be 3
returned       : 1   truncated: false
```

The envelope contradicts its own summary. §1.1 line 123 wants "N of total" in the summary and
`total_row_count` = the real total (§1.1 line 123).

**(b) No tool emits a `derived` block at all.** `grep -rn "derived" src/` finds only
`derivedEnvelope` and unrelated schema prose. Every computed field is a top-level, stringified
column: `pacing_pct`, `shortfall` (`find_anomalies.ts:95-99`), `fill_rate_now_pct`, `drop_pp`
(`:142-146`), `cause`, `est_opportunity` (`diagnose_fill_rate.ts:101-102`,
`diagnose_floor_pricing.ts:124-125`).

**(c) `numOr0` / `pctOrZero` / `Number(x) || 0` are all still there**, each turning absence into
zero: `src/report-run.ts:7-10` (carrying its own `ponytail:` note that PR 4 replaces it),
`find_anomalies.ts:276-280, 83-84, 188-192, 244-249`, `find_unused_ad_units.ts:50`,
`diagnose_fill_rate.ts:90, 149-159`, `diagnose_floor_pricing.ts:78-82`. In the executed
`compare_periods` run above, a missing metric came back as `""`, not `null`
(`compare_periods.ts:128-129`).

**(d) `DUPLICATE_JOIN_KEY` does not exist.** `GamErrorCode` (`src/errors.ts:1-13`) has twelve codes
and this is not one, though §1.5 lists it as new for 0.6.0.

### What the spec says

§1.4 (lines 159-162): "Every computed field lives under a `derived` object per row, with `method`
(one sentence), `heuristic: true|false`, and the input values it was computed from. `null` inputs
make the output `null`; a warning counts how many rows had a `null` input. `numOr0`, `pctOrZero` and
`Number(x) || 0` are removed." §1.5 (line 168): new code `DUPLICATE_JOIN_KEY` (§4.1).

### Smallest change

1. `src/errors.ts` — add `DUPLICATE_JOIN_KEY` to the union and a renderer. **Export
   `GAM_ERROR_CODES` derived from `Object.keys(CATALOG)`** and have
   `tests/server-errors.test.ts:11-15` read it: that hand-written array is a fourth copy of the
   code list and, because tests are not typechecked, adding a code silently leaves it uncovered by
   G6. This is the same defect class the controller fixed for the stdio-only tool names in Task 8
   (progress.md:52) — fix it the same way, once.
2. New `src/derived.ts` (≈60 lines): `num(cell): number | null` (no zero fallback), `ratio(a, b)`
   (null if either is null, null if `b === 0` — a zero denominator is not a zero rate), and a
   `derived({ method, heuristic, inputs, value })` builder so every block has the same key order.
   Delete `src/report-run.ts` once its two callers move (`numOr0`, `pct`).
3. `src/report-exec.ts` — `derivedEnvelope` takes `total_row_count` explicitly (the pre-slice
   count) and an optional `null_input_rows` count for the §1.4 warning. Keep the `RESULT_TOO_LARGE`
   check on the **returned** rows (line 583-584): it guards response size, and applying it to the
   pre-slice total would refuse calls that `top_n` had already made small.
4. `src/envelope.ts` — `inferSchema`'s `typeOf` (lines 84-89) returns `'string'` for an object, so
   a row carrying `derived: {…}` would be typed `string`. Either add `'object'` to `ColumnType`
   (`src/values.ts:23`) or have `derivedEnvelope` omit `derived` from the schema and say in
   `summary`/warnings that it is there. Decide once, here, before five tools depend on it.

### Tests

`tests/envelope.test.ts` covers key order only; no test asserts `total_row_count` against a
pre-slice count, and none asserts a `derived` block. New unit tests for `src/derived.ts` (null in →
null out; zero denominator → null, not 0) and an assertion in each of sections 3–5. A mutation
check that has teeth: make `ratio` fall back to 0 and the new `diagnose_fill_rate` test must fail.

### User-visible

**Yes, breaking.** §6 item 3 already announces it ("Tools that compute from rows return `derived`
blocks and refuse oversized inputs"), but the release note should say plainly that computed columns
move under `derived` and that a missing input now yields `null` where 0.5.2 printed `0`.

### Size / order

~200 lines. **Second** — sections 3, 4 and 5 all consume it. Landing it alone keeps the later
diffs about one tool each.

---

## 3. IDs beside names, and the `compare_periods` join
*(handoff bullet 3 — spec §4.1, finding F8, tests I2 and I3)*

### What is wrong today

Eleven tools group by an entity's **name only**:

| file:line | dimension(s) |
|---|---|
| `src/tools/top_advertisers.ts:23` | `ADVERTISER_NAME` |
| `src/tools/top_line_items.ts:25` | `LINE_ITEM_NAME`, `ORDER_NAME`, `ADVERTISER_NAME` |
| `src/tools/revenue_summary.ts:9-12` | advertiser / order / line_item / ad_unit → `*_NAME` |
| `src/tools/revenue_trend.ts:6-9` | advertiser / order / ad_unit → `*_NAME` |
| `src/tools/inventory_breakdown.ts:13-14` | advertiser / order → `*_NAME` |
| `src/tools/fill_rate.ts:6` | ad_unit → `AD_UNIT_NAME` |
| `src/tools/ad_speed.ts:10` | ad_unit → `AD_UNIT_NAME` |
| `src/tools/bidder_breakdown.ts:9` | ad_unit → `AD_UNIT_NAME` |
| `src/tools/video_breakdown.ts:8` | ad_unit → `AD_UNIT_NAME` |
| `src/tools/viewability_breakdown.ts:8` | ad_unit → `AD_UNIT_NAME` |
| `src/tools/yield_breakdown.ts:18` | ad_unit → `AD_UNIT_NAME` |

`reach_report.ts:10-13` and `sell_through.ts:11-14` already map to `[ID, NAME]` pairs — copy their
shape.

`compare_periods` joins on the full dimension tuple already (`src/tools/compare_periods.ts:97`), so
the tuple part of §4.1 is done; what is missing is the duplicate check. Executed — two advertisers
sharing a name, `top_n: 1`:

```
rows: [{"ADVERTISER_NAME":"Same","REVENUE":"100","REVENUE_prev":"50","REVENUE_delta_pct":"100.00"}]
```

`prevByKey` (`compare_periods.ts:98`) is a `Map`, so the second "Same" row silently overwrote the
first, and the tool published a 100%-growth figure that is an artefact of the collision. That is
finding F8 exactly.

### What the spec says

§4.1 (line 279): the ID dimension is requested **with** the name dimension for advertiser, order,
line item and ad unit; "Grouping, sorting and joins use the IDs. `compare_periods` joins on the full
dimension tuple; if a key still occurs twice in either period it returns `DUPLICATE_JOIN_KEY`
instead of joining." I2: "Two advertisers with the same name stay separate in `top_advertisers` and
in `compare_periods`." I3: a duplicated key returns `DUPLICATE_JOIN_KEY`.

### Smallest change

Each `DIM`/`PRIMARY`/`SECONDARY` map entry becomes a `string[]` and `buildQuery` spreads it — the
`reach_report.ts:10-13` pattern, one line per entry. Checked: `ADVERTISER_ID`, `ORDER_ID`,
`LINE_ITEM_ID` and `AD_UNIT_ID` are all offered in `HISTORICAL` **and** `AD_SPEED`
(`src/schema-generated.ts:23, 62, 318, 402`), so `ad_speed` is safe and H3 will prove it.
`viewability_breakdown.ts:47` guards against a duplicate dimension when `by` and `group_by` pick the
same one — that guard must compare the *pairs*, not the strings.

In `compare_periods`, replace the two `Map` builds with a counted build that returns
`gamError('DUPLICATE_JOIN_KEY', { key, period })` when a key occurs twice in either side.

### Tests

**None exist.** `tests/tools/top_advertisers.test.ts` and the other ten assert a row count against
a fixture that names the exact dimension list, and the mock matches fixtures on dimensions+metrics
(`src/gam-client.ts:206-209`), so **all eleven tool tests fail until their fixtures gain the ID
column** — that is the regression net for the fixture half, and it is automatic. New I2 (two
advertisers, same name, different IDs → two rows in `top_advertisers`, two keys in
`compare_periods`) and I3 (`DUPLICATE_JOIN_KEY`). H3 (`tests/tool-requests.test.ts:54`) covers the
"the new dimension exists for this report type" half with no new code.

### User-visible

**Yes, breaking**: every one of those tools gains a column and the row identity changes (two
same-named advertisers stop being merged by GAM). Definition hashes change again. Release note.

### Size / order

~280 lines, ~22 files, mostly mechanical. **Third** — it needs `DUPLICATE_JOIN_KEY` from section 2
and it rewrites part of `compare_periods`, which section 2 also touches.

---

## 4. Pacing: `pacing_status` and `find_anomalies` (and the repeated literal)
*(handoff bullets 2 and 5 — spec §4.3, §1.2; findings F3, F22; tests I6, I7, I13)*

### What is wrong today

Both still resolve `month_to_date` — `src/tools/pacing_status.ts:21-22` and
`src/tools/find_anomalies.ts:60-61`, each carrying the `ponytail:` marker PR 3's task 3 put there.
PR 3 ruling 3 records this as the one accepted intermediate state. Executed, clock 2026-10-01 in
`Asia/Tokyo`:

```
pacing_status                      -> INVALID_DATE_RANGE
  "date_range: no complete day in this period yet (month_to_date on 2026-10-01)"
find_anomalies pacing_underdelivery -> INVALID_DATE_RANGE  (same message)
```

Both tools are unusable on the first day of every month. The refusal itself is correct
(`src/dates.ts:110-111`); the tools are asking the wrong question.

Beyond the date: `pacing_status` computes nothing and its description says so — "pacing percentage
vs. goal is not available via the REST Reports API" (`pacing_status.ts:17`), which §4.3 ends.
`find_anomalies` computes its own percentage from a pro-rated month
(`find_anomalies.ts:63-66, 86-88`) using `monthProgress` (`:282-292`), which reads **UTC**
(`toISOString().slice(0,10)`, line 287) regardless of `ctx.timezone` — finding F3 — and treats
`LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE` as a monthly goal when for BULK/PRICE_PRIORITY it means
*remaining*. The probe measured what this costs: 1.117 computed against GAM's 1.027 (spec line 288).

**Already satisfied:** §4.3's "the local `previousPeriod` is deleted" — `find_anomalies.ts:3`
imports the shared one; there is no local copy left.

### What the spec says

§4.3 (lines 285-294), in full: `pacing_status` requests the eleven listed dimensions plus
`IMPRESSIONS`; it gains an optional `date_range` defaulting to `last_7_days` (a `month_to_date`
default "would fail on the first day of every month"); `delivery_indicator` is reported **exactly as
GAM returns it, only when the primary goal type is `LIFETIME`**, otherwise `null` with
`derived.reason: "no lifetime goal"`; a warning states these are live values at `run_time`; the
description stops saying pacing is unavailable. `find_anomalies` pacing uses the same report over
`last_7_days`, flags lifetime-goal items whose indicator is below `threshold_pct / 100`, sorted by
indicator ascending, and `monthProgress` is deleted.

All eleven dimensions exist in `HISTORICAL` — verified against `src/schema-generated.ts`:
`LINE_ITEM_PRIMARY_GOAL_TYPE` (:330), `_UNIT_TYPE` (:334), `_UNITS_ABSOLUTE` (:332),
`LINE_ITEM_DELIVERY_INDICATOR` (:306), `LINE_ITEM_LIFETIME_IMPRESSIONS` (:323),
`LINE_ITEM_START_DATE` (:342), `LINE_ITEM_END_DATE` (:311), `LINE_ITEM_UNLIMITED_END` (:347).
One trap: `LINE_ITEM_DELIVERY_INDICATOR` is declared `type: "string"` in the generated schema but
the probe returns a `doubleValue` (spec line 79). `convertValue` types from the value, so live rows
are fine, but an all-empty column falls back to the declared type (`src/values.ts:109-112`) — the
indicator must be read through the §2 `num()` helper, never `Number(cellText(...))`.

**I13 belongs here.** §1.2's last paragraph (spec line 144) — "For an open-ended line item, the end date is `null`
when `LINE_ITEM_UNLIMITED_END` is true; tools that show flight dates request that dimension
alongside the end date" — is implemented **nowhere**: `grep -rn "UNLIMITED_END" src/` matches only
`schema-generated.ts`. `pacing_status` is the first and only tool that will show a flight date, so
the rule lands with it. The probe saw `20370101` for open-ended items (spec line 78), which today
would be published as the date `2037-01-01`.

### Smallest change

`pacing_status.ts` is a near-rewrite (~110 lines): add `date_range` (optional, default
`{ relative: 'last_7_days' }`), swap the dimension list, and post-process per row —
which means it stops being an `executeReport` passthrough and becomes an `executeReportRows` +
`derivedEnvelope` tool, because it now has a `derived` block per row. (Note the consequence: its
provenance shape changes from `Provenance` to `DerivedProvenance`. `tests/result-order.test.ts:41`
picks the expected key list by `'inputs' in provenance`, so it adapts by itself.)

`find_anomalies.pacingUnderdelivery` (`:55-109`) is replaced by a call to the same helper: share
the query and the row mapping between the two tools rather than writing the eleven dimensions
twice. Delete `monthProgress` (`:282-292`).

**The repeated literal (bullet 5):** `'find_anomalies'` is written as the tool name at `:23` and
again as the `tool` argument at `:78, :123, :124, :177, :178, :233, :234` — seven copies of a string
that must match the `name` field for the logs to be usable. `const TOOL = 'find_anomalies'` at the
top, used by `name:` and all seven calls. While there: `lastDays(7, ctx.timezone, ctx.now)` +
`previousPeriod(baseRange)` is repeated verbatim in three of the four kinds (`:116-117, :168-169,
:226-227`) — one `weekOverWeek(ctx)` helper removes the same duplication a second time. Do both in
this task; they are three lines and the file is already open.

### Tests

`tests/tools/pacing_status.test.ts` (27 lines) asserts a row count on a two-dimension fixture: it
will fail on the new dimension list and must be rewritten. `tests/tools/find_anomalies.test.ts`
(151 lines) covers the four kinds; the pacing block is rewritten. New: **I6** (a `LIFETIME` item
reports GAM's indicator unchanged; a `DAILY` item with indicator `0` reports `null` with
`derived.reason: "no lifetime goal"`; the live-value warning is present; **with no `date_range` it
requests `last_7_days` and works on the 1st of a month** — set the clock to the 1st, which is the
test that fails today), **I7** (only lifetime-goal items under the threshold, ranked by indicator
ascending), **I13** (`LINE_ITEM_END_DATE` `20370101` with `LINE_ITEM_UNLIMITED_END` true → `null`;
false → `2037-01-01`). `tests/tool-table.ts:41`'s `pacing_status` row gains a `date_range` so H1/H3
keep covering it — and `tests/date-inputs.test.ts:46` asserts `CASES.length === 19`, which becomes
20 the moment `pacing_status` advertises a range field. **That count is the one assertion that will
fail without anyone touching its file; call it out in the task brief.**

### User-visible

**Yes, breaking** — §6 item 7 already lists it ("`pacing_status` and `find_anomalies` pacing report
GAM's delivery indicator instead of a computed percentage"). `pacing_status` gains an input,
loses `IMPRESSIONS`-only columns, and changes provenance shape. The release note should also record
that this is what ends the first-of-the-month failure, since the intermediate state was never
released.

### Size / order

~350 lines — the biggest single task. **Fourth**: it needs the `derived` plumbing (§2) and it
rewrites the file section 5 also touches, so it goes before, not after.

---

## 5. Heuristics under `derived`
*(handoff bullet 3 — spec §4.6, finding F14, test I10)*

### What is wrong today

Three heuristics are published as bare data with no method and no inputs:

- `diagnose_fill_rate`'s `cause` label (`src/tools/diagnose_fill_rate.ts:96, 101`) — seven rules,
  first match wins (`:167-175`), with the funnel ratios printed as percent strings (`:102-113`) and
  every input read through `numOr0` (`:148-160`). The row carries `ad_requests` but §4.6 requires
  "every input value used, including the `IMPRESSIONS` the fill-rate check reads" — `IMPRESSIONS`
  is not even in the query (`:69-76`).
- `diagnose_floor_pricing`'s `est_opportunity` (`:99-114, 124`) — two different formulas depending
  on the verdict, both against a network median computed from the qualifying rows (`:96-97`),
  reported as a bare number. The summary carries a caveat (`:140-142`); the row does not.
- `find_anomalies`' fill-rate, eCPM and viewability flags (`:134-147, :188-205, :244-260`).

### What the spec says

§4.6 (lines 305-307): those three "move under `derived` with `heuristic: true`, a one-sentence
`method`, and every input value used, including the `IMPRESSIONS` the fill-rate check reads.
`est_opportunity` keeps its name; its `method` says it is an estimate and how it is computed."
I10: "`diagnose_fill_rate` output includes `IMPRESSIONS` under `derived` with `heuristic: true`."

### Smallest change

Per tool, move the computed columns into `derived: { method, heuristic: true, inputs: {…} }` using
§2's builder, add `IMPRESSIONS` to `diagnose_fill_rate`'s metric list, and delete the `numOr0` /
`pct` imports. `find_anomalies`' three non-pacing kinds do the same with
`heuristic: true` (a week-over-week drop past a threshold is a judgement, not a GAM figure).

**Generic-MCP check:** the thresholds (`0.85`, `0.10`, `0.30`, `10_000`, `min_requests`) are generic
analytics heuristics, not publisher data, so they may stay — but §4.6's point is that they must now
be *stated* in `method` rather than implied by a label. Do not put an example network's numbers,
advertiser names or KV keys in the method strings or the new fixtures (CLAUDE.md, and
`global-constraints.md:16`: network `1234`, invented names).

### Tests

`tests/tools/diagnose_fill_rate.test.ts` (154 lines) and
`tests/tools/diagnose_floor_pricing.test.ts` (85 lines) assert the flat column names and will fail,
which is the regression net. New I10. Add one case that only the null rule catches: an ad unit with
a missing `AD_REQUESTS` must produce `null`, not `healthy` — today `numOr0` makes it `0`, which
makes `fillRate` `0`, which is not `healthy` by luck rather than by design.

### User-visible

**Yes, breaking** (§6 item 3). Row shape changes for three tools.

### Size / order

~340 lines. **Fifth**, after §4 vacates `find_anomalies.ts`.

---

## 6. `find_unused_ad_units`: active, leaf ad units only
*(NOT in the handoff's PR 4 list — spec §4.5, finding F12, test I9)*

### What is wrong today

`src/tools/find_unused_ad_units.ts:40-62` lists every ad unit `listEntities` returns and flags any
with `≤ min_requests` requests. It filters on nothing: an archived unit and a parent container
(which never serves directly, so it never appears in the report) are both reported as unused
inventory. That is the second half of finding F12.

There is a blocker one layer down: `toEntity` in `src/gam-client-rest.ts:125-146` maps a raw GAM
resource to `{ id, name, displayName? }` and **drops every other field**, so `status` and any
child/parent information never reach the tool, even though `Entity`
(`src/gam-client.ts:17-22`) has an index signature that would carry them.

### What the spec says

§4.5 (line 301): "Considers only ad units whose status is `ACTIVE` and that have no child ad units,
and states that rule in `warnings`. A unit absent from the report counts as zero ad requests,
because GAM omits rows whose metrics are all zero; the warning says so." I9: "ignores inactive units
and parents, and states the rule."

### Smallest change

Two options; the plan must pick one, and the choice needs a fact I could not confirm from the
repository:

- **(a)** Carry `status` and `hasChildren` through `toEntity` for `ad_unit` and filter on them.
  Needs confirmation that GAM's REST v1 `AdUnit` exposes `hasChildren` — the live probe
  (`tasks/probe-0.6.ts`) never fetched an ad unit, so **this is a question for the probe, not a
  guess**. That is how the other open questions in this programme were settled.
- **(b)** Carry `status` and `parentAdUnit` through, and derive leaf-ness inside the tool: a unit
  named as another listed unit's parent has children. Needs no undocumented field, but is only
  correct for the units actually listed, so it must say so when `max_units` truncates the list —
  the tool already warns about that cap (`:72-76`).

Either way `toEntity` changes for one entity type only, and the mock (`src/gam-client.ts:214-233`)
passes fixture entities through untouched, so test fixtures can carry the new fields with no mock
change. Add the two `warnings` sentences §4.5 requires.

### Tests

`tests/tools/find_unused_ad_units.test.ts` (123 lines) exists and passes; nothing in it exercises
status or parentage. New I9. Bite-check: an `ARCHIVED` unit and a parent unit in the fixture must
both be absent from the rows, and the rule must appear in `warnings`.

### User-visible

**Yes** — the tool will return fewer rows, and the ones it drops are the false positives. Release
note: one line.

### Size / order

~145 lines. **Sixth** — independent of everything above; it is sequenced here only because it needs
a probe answer, which can be obtained while sections 1–5 are being written.

---

## 7. §4.7 smaller fixes: `health_check`, summaries, prompts
*(NOT in the handoff's PR 4 list — spec §4.7, finding F15, test I12)*

### What is wrong today

**(a) A failed `health_check` reports success.** `src/tools/health_check.ts:29-46` catches the
failure and returns a `listEnvelope` with `status: 'failed'` inside it — and the comment at
`:33-35` argues for it. The server flags `isError` only for a `GamErrorEnvelope`
(`src/server.ts:188`), so a health check against a dead credential arrives as a **successful** tool
call. That is finding F15 and the whole point of the tool.

**(b) Summaries do not list filters or the sort.** `top_line_items.ts:31-33` mentions its one
optional filter; `run_report.ts:122-124` lists dimensions, metrics and dates only; no summary
anywhere names a filter list. §4.7 line 311: "Report summaries list the filters and sort."
(The sort half lands with section 1; the filters half is here.)

**(c) The bundled prompts ask for things the tools refuse or no longer do.**
`src/prompts.ts:35` — "with estimated revenue impact where possible" — and `:78` — "estimated lost
revenue" — are exactly what §4.7 line 312 removes. `:31` tells the LLM `find_anomalies` surfaces
items "at risk of underdelivery **this month**", which section 4 makes false (it becomes a live
delivery indicator over `last_7_days`). `:75` tells it to call `fill_rate` "grouped by day", which
is a real enum value (`fill_rate.ts:9`) but is written as prose rather than as the argument.

### Smallest change

(a) Return `gamError('AUTH_FAILED' | 'QUOTA_EXCEEDED' | 'INTERNAL_ERROR', { check: …, … })` naming
the failing check, keeping `attributeFailure` (`:50-57`) as the attribution and putting it in
`details`. §4.7 line 310 says "returns `isError: true` with the failing check named" — the detail
the current tool gets right (the diagnosis) must survive into the error body, not be traded away.
(b) `buildReportTool`'s summary path appends a filter clause when the query has filters — one place,
all fifteen report tools. (c) Edit four prompt lines.

### Tests

`tests/tools/health_check.test.ts:14-34` asserts `rows[0].status === 'failed'` — it **encodes the
bug** and must be rewritten, not extended. New I12 through the real server
(`tests/server-errors.test.ts`'s shape) so `isError` is asserted on the wire, not on the handler's
return. `tests/resources-prompts.test.ts` covers prompt rendering; add an assertion that no prompt
text contains "estimated revenue" / "estimated lost revenue", so the phrasing cannot come back.

### User-visible

**(a) is breaking** for anyone who parses `health_check`'s rows; it is not in §6's list, so the
release note needs a line of its own. (b) and (c) are additive.

### Size / order

~145 lines. **Seventh.**

---

## 8. Filter field names are not alias-resolved
*(handoff bullet 6 — pre-existing, found in PR 3 task 5's review; progress.md:31)*

### What is wrong today

`run_report` resolves dimension aliases (`src/tools/run_report.ts:50-57`, via
`resolveDimensionAlias`, `src/schema.ts:74-76`) but passes `input.filters` through untouched
(`:85`). `checkReportQuery` then validates the raw filter field against the canonical dimension set
(`src/schema.ts:141-143`) and refuses it. Executed:

```
run_report({ dimensions: ['CREATIVE_SIZE'], metrics: ['IMPRESSIONS'],
             filters: [{ field: 'CREATIVE_SIZE', op: '=', value: '300x250' }] })
-> INVALID_INPUT  "Unknown filter dimension: CREATIVE_SIZE"
```

The dimension resolved to `RENDERED_CREATIVE_SIZE` and would have worked; the identically-spelled
filter sank the call. The message is actively misleading — it says the name is unknown when the
server knows it well enough to rewrite it one line earlier.

Wider than the bug report: `resolveDimensionAlias` is called in **exactly one place** in `src/`.
`compare_periods` validates `input.dimensions` with no alias pass (`compare_periods.ts:41`), so
`compare_periods({ dimensions: ['CREATIVE_SIZE'] })` fails with "Unknown dimension: CREATIVE_SIZE",
and `save_query` (`saved_queries.ts:49`) does the same.

### What the spec says

Nothing directly — §4 does not mention aliases, and `DIMENSION_ALIASES` is a pre-0.6.0 convenience
(`src/schema.ts:65-71`). The governing rule is §1's goal that a caller gets data or a message that
tells them what to do, plus the existing code's own stated intent: "We accept the familiar name and
rewrite it so a caller asking for 'CREATIVE_SIZE' gets data instead of a 400 from GAM"
(`schema.ts:66-68`). Today that promise holds for dimensions and breaks for filters.

### Smallest change

Two shapes, and the plan should choose deliberately:

- **Narrow (≈10 lines):** in `run_report`, map `input.filters` through `resolveDimensionAlias` on
  `field` beside the existing dimension pass, appending the same style of warning. Fixes the
  reported bug, leaves `compare_periods` and `save_query` refusing the alias.
- **Elegant (≈40 lines):** one `canonicalizeQuery(query): { query, warnings }` in `schema.ts` that
  resolves dimensions *and* filter fields, called by `run_report`, `compare_periods` and
  `save_query`. Alias resolution then lives with the alias table instead of in one tool.
  Do **not** put it inside `executeReport`: rewriting a name after the definition is built would
  change the hash silently and make the warning hard to attach to the right result.

I recommend the elegant one — it is 30 lines more and it removes the "one tool knows about aliases"
asymmetry that produced this bug in the first place.

### Tests

`tests/schema.test.ts:128-129` tests `resolveDimensionAlias` in isolation and passes; no test puts
an alias in a filter. New: a `run_report` case asserting the aliased filter reaches GAM as
`RENDERED_CREATIVE_SIZE` (assert on the captured definition) with a warning naming the rewrite, plus
one for `compare_periods` if the elegant shape is chosen.

### User-visible

Additive — a call that was refused now succeeds. Worth a release-note line because it reads as a
fix, not a change.

### Size / order

~55 lines. **Eighth**, but it has **no dependency on anything** — it is the one item that could be
moved anywhere, including first as a warm-up, or dropped from PR 4 without consequence.

---

## 9. Fold-in minors from PR 3's ledger

PR 3's `progress.md` and the handoff's "Deferred minors" list nine items. My reading of which are
PR 4's:

**Take (all cheap, all in files PR 4 opens anyway):**

| Item | Where | Why PR 4 |
|---|---|---|
| `tests/server-errors.test.ts`'s `ToolDefinition` fixtures omit the now-required `annotations` (progress.md:54) | `tests/server-errors.test.ts:17-48` | Section 2 edits this file for `DUPLICATE_JOIN_KEY`; tests are not typechecked, so nothing else will ever catch it |
| The hand-copied `CODES` array (`tests/server-errors.test.ts:11-15`) | same file | Section 2; without it the new code is uncovered by G6. Fix by exporting the list from `errors.ts` |
| No tool-level test with `ctx.timezone != ctx.reportTimeZone` (progress.md:20) | any tool test | PR 4 is the tool-test PR; `makeCtx` takes an override, so it is a two-line `over` argument on one new assertion |
| `runOnce`'s doc comment omits the restore-on-non-fatal-ending guarantee (progress.md:15) | `src/report-exec.ts:120-126` | Section 1 and 2 both edit this file |

**Leave:**

- `describeIssue` echoes zod's message (handoff §4 bullet; ledger says PR 5 docs note) — no
  credential-shaped tool input is being added by PR 4, so the condition is unchanged.
- Unexercised array/record/nullable converter branches, and the JSON-Schema walker not traversing
  `additionalProperties`-as-schema — both are "no tool uses one today", and **PR 4 adds no
  record-typed field**: `pacing_status`'s new `date_range` reuses `dateRangeInput`. Still true after
  PR 4; leave them.
- A malformed `Authorization` header logging "wrong bearer token", and the best-effort
  `content-length` comment — both in `src/http-transport.ts`. PR 4 should not re-open the HTTP
  boundary a Critical was just fixed in; they belong wherever HTTP is next touched.
- **No test sends a real batched POST body to `/mcp`** (progress.md:119, offered to "PR 4 or 5") —
  I recommend **PR 5**, with the smoke script. It is an HTTP-transport assertion, and PR 5 already
  owns driving the packaged binary over HTTP (ruling P3-4); the two want the same fixture.
- `unknownZoneWarning`'s wording (progress.md:76) — ledger assigns it to PR 5. It is a user-visible
  string and belongs with the README pass.

---

## Not anticipated by the handoff — read this part

1. **§4.5 (`find_unused_ad_units`) and §4.7 (`health_check`, summaries, prompts) are in PR 4's spec
   scope and in none of the handoff's six bullets.** Sections 6 and 7. §4.5 additionally needs a
   change in `src/gam-client-rest.ts` — the only non-tool production file PR 4 must touch — and an
   answer from the live probe about `AdUnit.hasChildren`.
2. **`DUPLICATE_JOIN_KEY` does not exist yet** (`src/errors.ts:1-13`) although §1.5 lists it as a
   new 0.6.0 code, and the test list that covers it (`tests/server-errors.test.ts:11-15`) is a
   hand-written copy that will not complain when it is missed. Same defect class as the stdio-only
   names in PR 3 Task 8; fix the duplication, not just the instance.
3. **§4.1 is eleven tools, not two.** The handoff's "IDs beside names" reads as a `compare_periods`
   fix; it is a dimension-list change in every tool that groups by advertiser, order, line item or
   ad unit, and it fails eleven existing tool tests by design.
4. **I13 has no owner in the handoff.** §1.2's `LINE_ITEM_UNLIMITED_END` rule is implemented
   nowhere; it lands with `pacing_status`, the first tool to return a flight date.
5. **B1's fixture will not fail when `sorts` arrives** — it will silently stop covering it. The item
   is real but the failure mode is the opposite of what "the fixture gains `sorts`" suggests.
6. **`tests/date-inputs.test.ts:46` asserts `CASES.length === 19`** and becomes 20 the moment
   `pacing_status` advertises a `date_range`. It is the one test that breaks in a file nobody
   editing §4.3 would think to open.
7. **`LINE_ITEM_DELIVERY_INDICATOR` is declared `string` in `schema-generated.ts:306` but arrives as
   a `doubleValue`.** Not a bug today, but it decides how §4.3 must read it.
8. **`inferSchema` cannot type a `derived` object** (`src/envelope.ts:84-89`, `ColumnType` at
   `src/values.ts:23`). Decide in section 2, before five tools depend on the answer.
9. **Generic-MCP:** none of the proposed fixes bakes in publisher data. The two places to watch are
   the `method` strings §4.6 adds (state the rule, never an example network's values) and the new
   pacing fixtures (network `1234`, invented line-item names, per `global-constraints.md:16`). The
   per-tool sort metric in section 1 is a generic GAM metric name and is stated in the summary, so
   it implies nothing about a publisher's setup.
10. **§4.4 is already complete.** Do not let a plan re-do it.

---

## Recommended task breakdown (for `superpowers:writing-plans`)

Nine tasks. Sequential where files overlap; the dependency is noted per task. Sizes are lines
touched including tests.

| # | Task | Spec | Tests | Files | ~Lines | Depends on |
|---|---|---|---|---|---|---|
| 1 | `top_n`: sort in the definition, fetch `top_n` rows, summary "N of total, sorted by X desc"; B1 fixture gains `sorts` + a positional test | §4.2, §1.1 | **I1** (new), B1 (extend) | `gam-client.ts`, `report-definition.ts`, `report-tool-builder.ts`, `report-exec.ts`, 7 tools, `report-key.test.ts`, 7 tool tests | 270 | — |
| 2 | Derived plumbing: `src/derived.ts`, `derivedEnvelope` takes the pre-slice total, `DUPLICATE_JOIN_KEY` + exported code list, `inferSchema`/`derived` decision, delete `report-run.ts` | §1.4, §1.5 | new unit tests; G6 via the exported list | `errors.ts`, `derived.ts`(new), `report-exec.ts`, `envelope.ts`, `values.ts`, `server-errors.test.ts` | 200 | 1 (avoids a `report-exec.ts` collision) |
| 3 | IDs beside names in 11 tools; `compare_periods` refuses a duplicated join key | §4.1 | **I2**, **I3** (new); 11 tool tests re-fixtured; H3 free | 11 tools + `compare_periods.ts` + 11 tests | 280 | 2 |
| 4 | Pacing: `pacing_status` rewritten to GAM's indicator over an optional `date_range`; `find_anomalies` pacing on the shared helper; `monthProgress` deleted; unlimited-end rule; `TOOL` constant + `weekOverWeek` helper | §4.3, §1.2 | **I6**, **I7**, **I13** (new); `date-inputs` count 19→20; `tool-table` row | `pacing_status.ts`, `find_anomalies.ts`, `tool-table.ts`, 2 tool tests, `date-inputs.test.ts` | 350 | 2 |
| 5 | Heuristics under `derived` with `method` + `heuristic: true` + inputs; `IMPRESSIONS` added to the fill-rate query | §4.6 | **I10** (new); 2 tool tests rewritten | `diagnose_fill_rate.ts`, `diagnose_floor_pricing.ts`, `find_anomalies.ts`, 3 tests | 340 | 2, 4 |
| 6 | `find_unused_ad_units`: ACTIVE, leaf-only, rule stated in warnings; carry the needed fields through `toEntity` | §4.5 | **I9** (new) | `gam-client-rest.ts`, `find_unused_ad_units.ts`, 1 test | 145 | probe answer on `AdUnit.hasChildren` |
| 7 | §4.7: failed `health_check` → `isError` naming the check; summaries list filters; prompt text | §4.7 | **I12** (new); `health_check.test.ts` rewritten; prompt-wording assertion | `health_check.ts`, `report-tool-builder.ts`, `prompts.ts`, 3 tests | 145 | 1 (summary path) |
| 8 | Alias resolution for filter fields (`canonicalizeQuery` shared by `run_report`, `compare_periods`, `save_query`) | — (bug) | new `run_report` + `compare_periods` cases | `schema.ts`, 3 tools, 2 tests | 55 | none |
| 9 | Fold-in minors: `annotations` on the `server-errors` fixtures, the date-zone tool test, `runOnce`'s comment | — | 1 new assertion | `server-errors.test.ts`, 1 tool test, `report-exec.ts` | 30 | 2 |

**Total ≈ 1,815 lines across ~45 files.** Comparable to PR 3 (14 tasks, 907 tests); expect the test
count to land around 980–1,010.

**Brief-writing notes carried from PR 3's method** (they are what produced the real findings):

- Name the concrete risk per reviewer brief. For task 1: "check that `top_n` never enters the
  definition hash — run the same tool twice with different `top_n` and assert one report is
  created." For task 3: "check the duplicate detection looks at *both* periods, not just the
  previous one." For task 4: "check a `LIFETIME` item with a `null` indicator is not reported as
  `0`." For task 2: "check a zero denominator yields `null`, not `0`."
- Every new assertion gets a mutation check before the task is called done (rule 5 in the handoff).
- `BREAKING CHANGE:` footers on tasks 1, 3, 4, 5 and 7; §6 already covers 3, 4 and 5 — §6 items
  need **two new entries**: the seven `top_n` tools now sort and cap, and `health_check` now fails
  as an error.
- No AI attribution in any commit (CLAUDE.md lines 34-35); scan before every commit.
