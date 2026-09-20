# PR 5 scope — docs and release (`docs/0.6.0`)

**Status:** scope only. No code or doc changes were made writing this.
**Base to work against:** worktree `~/workspace/gam_mcp-0.6.0-smoke`, branch `feat/0.6.0-smoke`
(PRs 1–3 + the transports smoke script). All `README.md` and `src/` line numbers below are that branch.
**Spec:** `docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md` — note the copy on `feat/0.6.0-smoke`
differs from the one on `design/0.6.0` (PR 3 task 12 reworded §2.2 hash, §2.7 and test B1). Edit the
smoke-branch copy.

**Already done — do not re-scope:** `npm run smoke:transports`, its `--yes` gate and the hidden-report
warning, documented at `README.md:206-221`. That is the whole of the stack's README work so far.

---

## 0. The headline finding

The handoff's section 4 lists five README bullets. That understates it by a lot. **The only README hunk any
of PRs 1–3 touched is the Development block** (`README.md:204-221`); verified by
`diff <(git show design/0.6.0:README.md) README.md` on the smoke branch — 2 hunks, both in Development.

Everything above line 198 is 0.5.2 prose, and after this stack a large part of it is **actively wrong**, not
merely incomplete: the configuration table documents a default (`GAM_TIMEZONE=UTC`), a feature
(`GAM_INLINE_ROW_THRESHOLD` file spooling) and a cache contract ("parsed rows as gzipped JSON… No size
cap… No TTL") that no longer exist. PR 5 is a README rewrite of §Configuration, §Resources, §Reliability and
§Troubleshooting, not five inserts.

---

## 1. README changes

### 1.1 Configuration table (`README.md:53-68`) — rows that are wrong today

| README line | Current text | What it must say (verified in code) |
|---|---|---|
| 61 | `GAM_TIMEZONE` \| no \| **UTC** \| "IANA timezone for relative-date resolution" | Default is **the network's own time zone**, read at startup (`src/startup.ts:187-201`, `src/cli.ts:64`). It chooses **which calendar dates** are asked for; it does **not** change the zone GAM counts days in (every report is sent `timeZoneSource: PUBLISHER`, `src/gam-client-rest.ts:264`). An unknown IANA name **or a raw UTC offset** stops startup with exit code 2 (`src/startup.ts:46-52`, `src/zones.ts:23-31`). Both zones are reported separately in every result's `provenance` and on `gam://network`. |
| 62 | `GAM_INLINE_ROW_THRESHOLD` \| no \| 200 \| "spooled to a file (path returned in envelope)" | **Removed.** If set, startup logs `config.ignored` once with `reason: "results are paged; set GAM_PAGE_ROWS instead"` (`src/cli.ts:43-48`) and carries on. Replace this row with `GAM_PAGE_ROWS`. |
| — (new row) | — | `GAM_PAGE_ROWS` \| no \| `5000` \| Rows per page from GAM. Clamped to **10,000** (`GAM_MAX_PAGE_ROWS`), logged once as `config.page_rows_clamped` (`src/report-exec.ts:26-27,49-58`). Not a positive integer → startup stops. |
| 63 | `GAM_REPORT_TIMEOUT_MS` \| 300000 \| "Max polling time per report job" | Add: digits only (`3e5`, `5.0`, `-1`, `" 5"` all stop startup — `src/startup.ts:23-35`, `src/parse.ts` `wholeNumber`). Add the deployment rule from spec §2.6: **set it below your MCP client's call timeout**. Add: on `REPORT_TIMEOUT` the job is **not** abandoned — the next identical call resumes the same GAM operation instead of starting a second one (`src/report-exec.ts:127-155`). |
| 65 | `GAM_SAVED_QUERIES_FILE` | Add: **stdio mode only.** HTTP mode does not register the saved-query tools at all (`src/tools/index.ts:70-72`). |
| 66 | `GAM_REPORT_CACHE_DIR` \| "report results (parsed rows) persist as gzipped JSON… **No size cap** — clear the directory manually" | Now stores **result references, never rows** — one JSON file per entry at `<dir>/<network code>/<64-hex definition hash>.json`, directory created `0o700` (`src/cache.ts:104-122,177-197`; `src/startup.ts:161-163`). See §1.2 for the growth/pruning wording. |
| 67 | `GAM_REPORT_CACHE_TTL_MS` \| "**Disk-cache** TTL… Only meaningful when `GAM_REPORT_CACHE_DIR` is set" | Applies to **both tiers** now (`src/cache.ts:63,117,148-151`). Default 1 h. **`0` turns result reuse off entirely** — `putDone` deletes instead of storing (`src/cache.ts:252-256`). |
| 68 | `GAM_HTTP_PORT` \| "listens for Streamable-HTTP… Use for hosted/team deployments" | Keep, and add the four facts in §1.4. Digits only, 1–65535 (`src/startup.ts:76-80`). |
| — (new rows) | — | `GAM_HTTP_BEARER_TOKEN` and `GAM_HTTP_ALLOWED_HOSTS` — see §1.4. |

Also: `README.md:5` says "**12 tools**". The real counts are **29 tools over HTTP, 33 over stdio**
(`src/tools/index.ts:36-66` = 29 `SHARED_TOOLS`; `toolsFor` at `:70-72` adds the 4 `SAVED_QUERY_TOOLS` for
stdio only — the 33/29 split is asserted on the wire in `tests/transports-e2e.test.ts`). Stale before this
release, but PR 5 is the place to correct it.

### 1.2 Disk-tier growth and pruning — new prose under `GAM_REPORT_CACHE_DIR`

Facts, from `src/cache.ts`:

- Memory tier is an LRU bounded at `CACHE_MAX_ENTRIES = 1000` (`cache.ts:61,121`).
- **The disk tier has no bound at all.** `writeDisk` is called on every `put` (`cache.ts:210-218`); nothing
  sweeps the directory.
- Files are removed only **lazily, on a read**: `get()` removes an entry it finds past its TTL
  (`cache.ts:238-241` → `remove` → `removeDisk`). A key never asked for again is never revisited, so its
  file stays forever.
- An entry evicted from the memory LRU **leaves its file behind** — and that is deliberate, because the file
  is what lets a later process (or a restart) find the result again (`cache.ts:233-237`).
- Each file is small (a report/result/operation name plus timestamps), so this is a file-count problem, not a
  disk-space one.

Draft:

> **Growth and pruning.** One small JSON file per distinct report query, under
> `<GAM_REPORT_CACHE_DIR>/<network code>/`. The 1,000-entry bound applies to the in-memory tier only — the
> directory itself is unbounded. Files are deleted lazily: an entry is removed when a later call looks it up
> and finds it past `GAM_REPORT_CACHE_TTL_MS`, so a query that is never repeated leaves its file behind
> indefinitely. The files hold result references, not rows, so they stay small; if the file count matters,
> delete the directory while the server is stopped. Nothing is lost — a missing entry just means the next
> call re-runs the report.

### 1.3 Ignored 0.5.x row files — new prose under `GAM_REPORT_CACHE_DIR`

Verified: 0.5.2 wrote `<sha256 of key>.json.gz` **directly in `GAM_REPORT_CACHE_DIR`**
(`git show main:src/cache.ts:81-82,110-115`, gzipped rows). 0.6.0 writes `<hash>.json` **in a per-network
subdirectory** (`src/cache.ts:157,179`; `src/startup.ts:161-163`). So the old files are not read, not
migrated and not deleted — they are simply invisible to the new code.

Draft:

> **Upgrading from 0.5.x.** 0.5.x stored gzipped report *rows* as `*.json.gz` directly in this directory.
> 0.6.0 stores result *references* as `*.json` under a per-network subdirectory, and never reads or deletes
> the old files. They are inert; delete them yourself to reclaim the space.

### 1.4 The HTTP settings and a busy port — new subsection

Belongs under §Configuration, after the `GAM_HTTP_PORT` row. Facts from `src/http-transport.ts` and
`src/startup.ts:61-101`:

- `GAM_HTTP_BEARER_TOKEN` — when set, every request except `GET /healthz` must carry
  `Authorization: Bearer <token>`, compared with `timingSafeEqual`; missing or wrong is `401` with
  `WWW-Authenticate: Bearer` (`http-transport.ts:118-124`). Must be **printable ASCII without spaces**
  (`startup.ts:81-84`) — anything else stops startup, and the value is never logged or quoted in any error.
  **When unset, startup logs one `http.unauthenticated` warning and serves every request**
  (`http-transport.ts:172-177`).
- `GAM_HTTP_ALLOWED_HOSTS` — comma-separated **host names without ports**. A request whose `Host` names
  anything else gets `403`, **checked before the token** (`http-transport.ts:110-116`). A value that is not a
  bare host name stops startup (`startup.ts:90-104`). Unset means no Host check at all.
- Body limit — **1 MiB (1,048,576 bytes)**, `413`. Enforced while reading, not after buffering
  (`http-transport.ts:30,203-222`). 0.5.2 had no limit.
- Every refusal (`401`, `403`, `404`, `413`) sends `Connection: close` and drains the request, so a refused
  request cannot wedge a keep-alive socket (`http-transport.ts:83-92`).
- `GET /healthz` answers `{"status":"ok"}` with **no token and no Host check** (`http-transport.ts:104-109`).
- Saved-query tools are not registered in HTTP mode; `GAM_HTTP_BEARER_TOKEN` and `GAM_HTTP_ALLOWED_HOSTS`
  set **without** `GAM_HTTP_PORT` log `config.ignored` in stdio mode (`src/cli.ts:38-42`,
  `src/startup.ts:105-107`).

Busy port — draft wording (message verified at `src/http-transport.ts:43-51`, exit path `src/cli.ts:94-97`):

> **A port already in use.** The server does not retry or fall back to stdio. It writes
> `gam-mcp: GAM_HTTP_PORT <port> is already in use by another process` to stderr and exits with code 2. Any
> other listen failure exits 2 the same way, naming the OS error code. Settings are validated before the
> credential is used, so a misconfigured port fails before any GAM request is made.

### 1.5 `cache.hit` on later pages — belongs under §Reliability, beside the paging prose

The fact: `fetchReportPage` always passes `cacheHit: false` (`src/report-exec.ts:518`), while the first page
passes the real value (`src/report-exec.ts:431`). So a three-page result whose first page was a cache hit
reports `provenance.cache.hit: true, false, false`. This is not a bug — a cursor page always re-reads the
result from GAM — but it reads like one.

Draft:

> **`cache.hit` describes the first page only.** `provenance.cache.hit` says whether *this call* answered
> from a result an earlier call had already produced. Pages fetched with `fetch_report_page` always read
> from GAM, so they report `cache.hit: false` even when the first page reported `true`. The `run_time` and
> `date_range` on every page are the result's own, so the numbers still all come from one run — use
> `run_time`, not `cache.hit`, to tell how old the rows are.

Also note `src/report-exec.ts:328-329`: every cursor page carries the warning *"Some caveats, such as
renamed dimensions or rewritten key-value filters, are listed only on this report's first page; read them
with these rows."* Worth one sentence in the same paragraph.

### 1.6 Hidden, undeletable reports — new §Reliability (or §Setup) subsection

Facts: report display names are `gam-mcp <first 16 hex of the definition hash>` (`src/report-key.ts:65-69`);
`visibility` is left unset so GAM defaults to `HIDDEN` (`src/gam-client-rest.ts:264`); reuse is by
`reports.list` on `displayName` (`src/report-reuse.ts:40-43`); a name held by a report with a different
definition logs `report.name_taken` (`src/report-reuse.ts:46-50`). The REST API has no delete for reports
(spec §Evidence).

Draft:

> **This server creates report objects in your network.** Running any report tool defines a Google Ad Manager
> report named `gam-mcp <hash>`, where the hash identifies the exact query. Reports are created **hidden**, so
> they do not appear in the Ad Manager UI's report list, and the Ad Manager API has **no delete operation for
> reports** — once defined, one stays in the network. This is deliberate: the same query finds and re-runs its
> existing report instead of defining a new one, so the number of these objects is bounded by the number of
> *distinct* queries you run, not by how often you run them. There is no way for this server to clean them up.

### 1.7 Other README lines this stack invalidates

| Line | Problem |
|---|---|
| 119 | `gam://network` — "Configured network code + timezone". Now `network_code`, `currency_code`, `report_time_zone`, `date_time_zone` (`src/server.ts:59-73`). The key `timezone` no longer exists (breaking, see §3). |
| 80 | `pacing_status` — "pacing % vs goal not directly available — use `find_anomalies`". PR 4 replaces this with GAM's delivery indicator. Coordinate: if PR 4 ships first, this line is PR 4's; if PR 5 ships first, leave it and let PR 4 fix it. |
| 102-105 | The four saved-query rows need "**stdio mode only**". |
| 186-187 | §Reliability. "Pagination" describes `lookup` only — report paging via `next_cursor`/`fetch_report_page` is missing. "In-process cache — identical report queries within a session return cached rows instantly. **No TTL** (closed-period reports are immutable)" is wrong on all three counts: it is a result-reference cache, it has a 1 h TTL in both tiers, and in HTTP mode it is shared across callers. |
| 189-196 | §Troubleshooting has no entry for the new codes. Add: `INVALID_INPUT` (an argument no tool declares, naming the key), `INVALID_DATE_RANGE` on the first day of a period-to-date range, `AMBIGUOUS_NAME`, `REPORT_RESULT_EXPIRED`, `RESULT_TOO_LARGE`, and the HTTP `401`/`403`/`413`. Error codes enumerated at `src/errors.ts:2-13`. |
| 70-108 | The Tools table has no `fetch_report_page` row. |
| 155 | Example 9 uses `base_range:{relative:"month_to_date"}` — now `INVALID_DATE_RANGE` on the 1st of the month. Either reword or pick another example. |
| 5 | "12 tools" (see §1.1). |

**Generic-MCP check for all README drafts:** no network codes, no advertiser or key names. Note
`README.md:142,152` already carry publisher-ish ad-unit and placement strings — pre-existing,
out of PR 5's mandate, but flag it to the owner rather than adding more of the same. Do not copy the live
the network code out of the spec into the README or the release notes.

---

## 2. Spec changes

All in `~/workspace/gam_mcp-0.6.0-smoke/docs/superpowers/specs/2026-09-17-gam-mcp-0.6.0-design.md`.

### 2.1 §6 gains the offset-time-zone refusal (the handoff's item; **verified breaking**)

§6 is at line 332; the list runs 334-342. Item 8 today reads "`GAM_TIMEZONE` defaults to the network's zone
instead of UTC" — which does not cover an offset form, because an offset is not an *unknown* zone.

Verification that it is breaking: 0.5.2 read the variable raw (`git show main:src/cli.ts:31` —
`process.env.GAM_TIMEZONE ?? 'UTC'`) and handed it straight to `Intl.DateTimeFormat({timeZone})`
(`git show main:src/dates.ts:93-105`), which **accepts** `+08:00`. 0.6.0's `canonicalTimeZone` returns
`null` for anything Intl resolves to a leading `+`/`-` (`src/zones.ts:23-31`, introduced by `9893015`), and
`readSettings` turns that into a startup stop (`src/startup.ts:46-52`). So a deployment on
`GAM_TIMEZONE=+08:00` starts on 0.5.2 and refuses to start on 0.6.0.

Draft §6 item (append as 10, or fold into 8):

> 10. `GAM_TIMEZONE` must be an IANA zone name. A raw UTC offset (`+08:00`, `-0500`) was accepted by 0.5.2
>     because Node's `Intl` accepts one; it now stops startup. `Etc/GMT-8` and the like stay accepted — they
>     are IANA names.

### 2.2 §2.6's `pending` bullet is now wrong (carried from PR 2's final review: "spec §2.6 wording → PR 5")

§2.6 line 223 says the cache records a `pending` entry **after** `GAM_REPORT_TIMEOUT_MS`. The code records
it **the moment GAM accepts the run** (`src/report-exec.ts:143-144`), and re-records it after any poll
failure other than `REPORT_FAILED`, keeping the original start time (`src/report-exec.ts:147-154`,
`src/cache.ts:271-276`). That is the stronger guarantee — a crashed or killed process also leaves a
resumable entry — and the spec undersells it.

Draft replacement bullet:

> - **Timeout.** A run is recorded as `pending` for its hash as soon as GAM accepts it, so a call that dies
>   later — a `REPORT_TIMEOUT` after `GAM_REPORT_TIMEOUT_MS` (default 300,000), a poll failure, or the
>   process stopping — leaves the operation for the next identical call to resume instead of starting a new
>   run. Only GAM reporting the run *failed* forgets it. A resumed entry keeps its original start time, and
>   `pending` entries expire after one hour.

### 2.3 §1.1's `truncated` bullet (carried from PR 1's final review)

§1.1 line 123: "`truncated` is `true` whenever `returned_row_count < total_row_count` for any reason other
than a requested `top_n`." The implemented rule is
`nextCursor !== null || (total !== null && offset + returned < total)` (`src/report-exec.ts:390`) — i.e. it
is about *this result having more rows to fetch*, and `top_n` never reaches this envelope (those tools go
through `derivedEnvelope`). Reword to state the implemented rule and say separately that `top_n` results are
described in `summary` and are not this envelope's concern. **Confirm against PR 4's `derivedEnvelope` work
before writing** — PR 4 owns `derivedEnvelope`'s total-after-`top_n` behaviour.

### 2.4 §9 gains the per-request GAM timeout (see §5)

---

## 3. Release notes

### 3.1 What release-please will generate, mechanically

`release-please-config.json` is **not** on defaults — `refactor` is mapped to a visible "Changed" section;
only `docs`, `chore`, `ci` and `test` are hidden. With `bump-minor-pre-major: true` and breaking changes
present, 0.5.2 → **0.6.0**.

74 commits in `main..feat/0.6.0-smoke`: 30 `fix`, 21 `feat`, 5 `refactor`, 10 `test`, 7 `docs`, 1 `chore`.
So the generated CHANGELOG will be **56 bullets** across three sections plus a `⚠ BREAKING CHANGES` block.

### 3.2 The nine breaking changes release-please surfaces on its own

Each of these carries a `BREAKING CHANGE:` footer, so its footer text lands in the breaking block verbatim.
Verified commit by commit over `main..feat/0.6.0-smoke`; there are exactly nine.

| # | Commit | Subject | What the footer says |
|---|---|---|---|
| 1 | `0047f5e` | `refactor!: remove the CSV and file-path result path` | No `file_path`/`preview_rows`; results are paged via `next_cursor` → `fetch_report_page`; `row_count` → `total_row_count` + `returned_row_count`; typed row values; real `schema` types; `GAM_INLINE_ROW_THRESHOLD` ignored, use `GAM_PAGE_ROWS`. |
| 2 | `d68ab25` | `fix: flag every tool error with isError` | Returned error envelopes (`REPORT_FAILED`, `REPORT_TIMEOUT`, `INVALID_DATE_RANGE`, …) now arrive with `isError: true` instead of as successful results. |
| 3 | `09b4e78` | `feat!: read the network with the configured credential before serving` | Startup fails when the credential cannot read the network; `GAM_TIMEZONE` defaults to the network's zone, not UTC; an unknown `GAM_TIMEZONE`, a non-numeric `GAM_NETWORK_CODE`, or an out-of-range `GAM_REPORT_TIMEOUT_MS` / `GAM_REPORT_CACHE_TTL_MS` stops startup. |
| 4 | `70c7ac2` | `feat!: answer repeated reports from the cached result` | `GAM_REPORT_CACHE_TTL_MS` now applies in memory as well as on disk (default 1 h; `0` disables reuse); `GAM_REPORT_CACHE_DIR` holds result references in `<dir>/<network code>/`; 0.5.x row files are ignored. |
| 5 | `fde7fba` | `feat!: check every date range in the date time zone` | Relative range `today` removed; `month_to_date` / `quarter_to_date` / `year_to_date` are `INVALID_DATE_RANGE` on the first day of their period; impossible dates (`2026-02-30`) refused. |
| 6 | `1ee4201` | `feat!: report tools take any date range and check it by report type` | Report tools refuse impossible dates and an end date after yesterday; `sell_through` refuses a window starting before today or given as a relative range. |
| 7 | `b1e4d77` | `feat!: refuse unknown tool arguments and describe every field` | An argument a tool does not declare, at any depth, is `INVALID_INPUT` naming the key instead of being dropped. |
| 8 | `fc4a19f` | `feat!: annotate every tool and offer saved queries over stdio only` | HTTP mode no longer lists or runs `save_query`, `list_saved_queries`, `run_saved_query`, `delete_saved_query`; `gam://network` replaces `timezone` with `report_time_zone` and `date_time_zone`. |
| 9 | `7320b4c` | `feat: read the HTTP settings as strictly as the rest, and stop cleanly on a busy port` | `GAM_HTTP_PORT`, `GAM_PAGE_ROWS`, `GAM_REPORT_TIMEOUT_MS` and `GAM_REPORT_CACHE_TTL_MS` accept digits only; `3e5` or `8080.0` now stops startup. |

(#9 is a `feat:` without `!` but *with* a footer — release-please keys off the footer, so it is surfaced.)

### 3.3 Breaking or near-breaking changes release-please will **miss**

Each of these lands in "Fixed" or "Added" as an innocuous one-liner, with nothing marking it as a break.
These are what the hand-written note exists for.

| Commit | Subject | Why it needs a hand-written note |
|---|---|---|
| `9893015` | `fix: quote the port in startup errors and refuse offset time zones` | **Startup-stopping.** `GAM_TIMEZONE=+08:00` worked on 0.5.2 (verified above) and now exits 2. Buried under "Fixed" between two cosmetic changes. |
| `1ee4201` + `b1e4d77` | (the two strictness commits) | Split across two breaking entries; neither says "every tool". See §3.4 for the consolidated note. |
| `8a38ee7` | `fix: report a key or ad unit name that matches more than one entity` | **Behaviour break.** 0.5.2 silently took `matches[0]` (spec F15); a name that matches more than one entity is now `AMBIGUOUS_NAME` with the candidates. A query that used to return numbers now returns an error. |
| `ae210b2` | `fix: check every report query against its report type before GAM sees it` | **Behaviour break.** Unknown dimensions/metrics/filter dimensions, and names the derived report type does not offer, are `INVALID_INPUT` **before** anything reaches GAM. Worth pairing with the known gap PR 4 owns: filter field names are not alias-resolved, so a filter on an aliased dimension name is refused although the dimension alias exists. |
| `dcc7e36` | `feat: guard the HTTP endpoint with a bearer token, a host list and a body limit` | **New 1 MiB request-body limit** where 0.5.2 had none (spec F15). An HTTP caller sending a large batch now gets `413`. Lands in "Added", reads as a pure improvement. |
| `fe3d1ff` + `61705dc` + `b28699d` | name each report after its definition hash / find a report by name before creating one / run every report in the network's zone and currency | Together these change what appears **in the user's Ad Manager network**: hidden report objects named `gam-mcp <hash>`, discoverable by name, undeletable. Nothing in any footer says the server now writes named, persistent objects into the network. |
| `e8a1ea6` | `fix: close every tool call in the log and keep result keys in contract order` | Result JSON key order changed (qualifiers before `rows`). Anything parsing positionally or diffing output notices. Minor, but silent. |

### 3.4 Draft: the strictness note (write once, for all tools)

This is the one the handoff calls out. `1ee4201` (task 6) made the ~14 `buildReportTool` tools strict but its
footer documents only the date rules; `b1e4d77` (task 7) made the other ~19 strict and its footer describes
strictness generically. A changelog reader gets two partial statements and no "all tools". Verified scope:
`.strict()` is applied in `src/tool-input.ts:42,58,69` (the shared report-tool input) and in every remaining
tool module.

> ### Every tool input is now strict
>
> In 0.5.2, an argument a tool did not declare was silently dropped. A misspelled `filters` meant the report
> ran **network-wide** and nothing in the answer said so.
>
> In 0.6.0 **every tool, without exception, refuses an argument it does not declare**, at any depth of the
> input — top-level keys, objects inside arrays, and nested objects alike. The refusal is `INVALID_INPUT`
> and it names the offending key and where it sits, so a client can correct it.
>
> Two consequences worth checking before you upgrade:
>
> - Any client, script or saved prompt that passes an extra field "just in case" now fails instead of being
>   quietly ignored.
> - A key you meant to be a filter, a `top_n` or a `group_by` and spelled wrongly used to change the meaning
>   of your report in silence. It now fails loudly. Expect to find one or two of these.
>
> Every field in every advertised schema also carries a description, a default and its bounds now, so an LLM
> client can see what a tool accepts without guessing.

### 3.5 Draft: the offset-time-zone note

> ### `GAM_TIMEZONE` must be an IANA zone name
>
> 0.5.2 passed `GAM_TIMEZONE` straight to the runtime, which accepts a raw UTC offset such as `+08:00`.
> 0.6.0 refuses one: only IANA names (`Region/City`, and `Etc/...` forms, which are IANA names despite
> looking like offsets) are accepted, and an offset stops startup with exit code 2 naming the variable.
>
> An offset cannot express daylight-saving transitions, so a date resolved through one silently disagrees
> with the network's own calendar for part of the year. If your deployment sets an offset, replace it with
> the zone name it stood for — or unset it, which now means "the network's own time zone" rather than UTC.

### 3.6 Draft: the `fix:`-commit framing paragraph

The handoff flags this and it is real. Of the 30 `fix:` commits, **19 repair code that was written earlier in
this same unreleased stack** — they never reached a published version, so listing them as 0.6.0 bug fixes
implies 0.5.2 had defects it did not have.

In-stack-only (verified: every source file each one touches was added in `main..HEAD`, or the behaviour it
changes was introduced by a named earlier commit in the stack):
`24f677a`, `76ae242`, `35b7f8d`, `00a6da9`, `8a284a8`, `acd0e10`, `5defed8`, `03282a1`, `1be79cf`,
`53ff037`, `2865392`, `79e7494`, `e128d86`, `92b7c4f`, `37c2e08`, `26c0ce4`, `0ff4179`, `b5abb08`,
`e391ece` — plus the two HTTP connection-stall fixes repair `dcc7e36`, which is itself new in this release.

Genuine 0.5.2 defects (11): `d68ab25`, `d3f3be6`, `9bcf4ae`, `6221c02`, `40bdd83`, `9893015`, `13a9576`,
`ae210b2`, `e8a1ea6`, `b1f9a5f`, `8a38ee7`. (`13a9576` is the one genuinely mixed case — the startup hints
it adds are a 0.5.2 improvement, the `REPORT_RESULT_EXPIRED` message it adds belongs to this release's own
new code; the draft below leaves it out rather than mis-describing it.)

> **About the "Fixed" list below.** 0.6.0 was developed as one stack of five changes, and most of the entries
> under *Fixed* repair code added earlier in that same stack — they never appeared in a published version.
> The defects 0.6.0 actually fixes in **0.5.2** are: tool errors returned without `isError`; a report POST
> retried after Ad Manager had already acted on it; credential-library messages reaching logs and errors; a
> malformed inline key echoed in its own error; report queries reaching Ad Manager without being checked
> against their report type; a name matching more than one entity resolved silently to the first match; a
> `GAM_TIMEZONE` offset accepted as if it were a zone; a tool call left unclosed in the log; a result that
> could not be serialised logged twice; and a capped `find_unused_ad_units` run whose cap was mentioned only
> in the summary.

### 3.7 Where the note goes

Spec §8 says the owner merges the release PR. Concretely: after the stack lands and release-please opens the
0.6.0 PR, **edit `CHANGELOG.md` in that PR** to add an "Upgrading from 0.5.2" preamble containing §3.4, §3.5,
§3.6 and the §3.3 items, above release-please's generated sections. Do not rewrite the generated sections —
release-please will restore them.

Also confirm before merging: the PR bodies for #7/#8/#9 carry their `BREAKING CHANGE:` footers, because a
**squash merge collapses 74 commits into 3** and release-please then reads only the squash messages. This was
already flagged in PR 1's ledger ("PR body must carry BREAKING CHANGE footers if squash-merged → controller
at PR creation") — re-verify it at merge time, because getting it wrong loses all nine footers.

---

## 4. Code wording fix — `unknownZoneWarning`

**Location:** `~/workspace/gam_mcp-0.6.0-smoke/src/zones.ts:135-139` (the handoff says "~168";
after PR 3's edits the function sits at 135-139 and the file is 139 lines).

**Current:**

```ts
// The warning for a result whose report zone this server cannot name.
export function unknownZoneWarning(dateZone: string, source: string | undefined): string {
  return `GAM counted this report's days in a time zone this server cannot name (time zone source ${source ?? 'not stated'}), ` +
    `so they may not cover the same hours as dates chosen in ${dateZone} (GAM_TIMEZONE).`;
}
```

**The bug.** `reportZoneOf` (`src/zones.ts:122-133`) returns `null` in four different situations, and the
warning attributes all four to the *source*:

| Definition | Why the zone is unnameable | What the message says today |
|---|---|---|
| `{timeZoneSource:'PROVIDED', timeZone:'<unknown name>'}` | The **zone name** is not one this runtime knows, or is an offset | "time zone source PROVIDED" — implies `PROVIDED` is the unrecognised thing. **This is the bug.** |
| `{timeZoneSource:'PROVIDED'}` | The definition **names no zone at all** | same, equally misleading |
| `{timeZoneSource:'AD_EXCHANGE'}` | Genuinely a source no zone follows from | correct |
| `{}` / `TIME_ZONE_SOURCE_UNSPECIFIED` | No source stated | correct |

Behaviour is right (`reportZoneOf` returns `null` in all four, verified by `tests/zones.test.ts:134-148`);
only the attribution is wrong.

**Proposed replacement** (takes the definition, matching `reportZoneOf`'s shape, so a future source cannot be
forgotten at the call site):

```ts
// The warning for a result whose report zone this server cannot name. The
// reason has to name what is actually unusable: PROVIDED is a source this
// server understands — it is the zone name beside it that it cannot use —
// while any other source is one no zone follows from.
export function unknownZoneWarning(
  dateZone: string,
  definition: { timeZoneSource?: string; timeZone?: string },
): string {
  let reason: string;
  if (definition.timeZoneSource === 'PROVIDED') {
    reason = definition.timeZone
      ? `the report gives its time zone as ${JSON.stringify(definition.timeZone)}, which is not an IANA time zone name this runtime knows`
      : 'the report says its time zone was provided but does not say which';
  } else if (definition.timeZoneSource) {
    reason = `no zone follows from its time zone source, ${definition.timeZoneSource}`;
  } else {
    reason = 'the report states no time zone source';
  }
  return `GAM counted this report's days in a time zone this server cannot name: ${reason}. ` +
    `Those days may not cover the same hours as dates chosen in ${dateZone} (GAM_TIMEZONE).`;
}
```

**Call site**, `src/report-exec.ts:360-363` — one line changes:

```ts
const reportZone = reportZoneOf(a.definition, a.ctx.reportTimeZone);
const zone = reportZone === null
  ? unknownZoneWarning(a.ctx.timezone, a.definition)          // was (a.ctx.timezone, a.definition.timeZoneSource)
  : zoneWarning(a.ctx.timezone, reportZone, definitionRange(a.definition) ?? a.dateRange);
```

*Smaller-diff alternative if the signature change is unwanted:* keep `(dateZone, source)` and add a third
optional `zoneName` parameter, branching the same way. The definition-shaped version is preferred — both
zone helpers then read the same object, and there is one fewer way to call it wrongly.

**Tests to update / add:**

- `tests/report-zones.test.ts:124-129` asserts the current string **verbatim**, for `{timeZoneSource:'AD_EXCHANGE'}`
  and `{}`. Both assertions must be updated to the new text.
- Add two cases there (or in `tests/zones.test.ts` beside the `reportZoneOf` block at 134-148) for
  `PROVIDED` with an unknown zone name and `PROVIDED` with none, asserting the message names the **zone
  name**, not the source. Neither case has envelope-level coverage today — that is why the wording slipped
  through.

**Commit message** (Conventional Commits, no AI attribution):
`fix(zones): say which part of a report's time zone this server cannot use`

---

## 5. Post-0.6.0 todos to record

Record in spec §9 (`Follow-ups and open items`, line 491) and mirror in `tasks/todo.md`.

1. **A per-request GAM timeout** (the handoff's item). Today `GAM_REPORT_TIMEOUT_MS` is process-wide
   (`src/startup.ts:9`, `src/report-exec.ts:71`) and is the only bound on a report wait. An HTTP deployment
   serving several clients cannot give a fast caller a short deadline and a batch caller a long one, and a
   caller cannot say "give up after 30 s and hand me the operation to resume". The resume machinery
   (`src/report-exec.ts:127-155`) already makes a short per-call deadline safe — a timed-out call leaves a
   `pending` entry the next call resumes — so this is a tool-input and plumbing change, not a design change.
   Draft §9 entry:

   > - **A per-request GAM timeout.** `GAM_REPORT_TIMEOUT_MS` bounds every report wait in the process.
   >   Because a timed-out run is recorded as `pending` and resumed by the next identical call, a per-call
   >   deadline would be safe: a caller could ask for a short wait, get `REPORT_TIMEOUT` with the operation
   >   named, and resume by repeating the call. Needed most in HTTP mode, where one process serves callers
   >   with different client-side timeouts.

2. **Result retention** — already in §9 line 494, but it names the live network code and two real report
   IDs. The measurement is still outstanding; when it is recorded, consider moving the identifiers out of the
   committed spec.

3. Carry forward the still-open deferred minors from the handoff (lines 154-169) — none are PR 5's to fix,
   but the two with a documentation flavour belong in a note rather than nowhere:
   - `describeIssue`'s fallback echoes zod's default message, which quotes the received value. Harmless today
     because no tool input is credential-shaped; a code comment at that site is the right home (PR 3 task 4
     assigned this to "PR 5 docs note").
   - The early `content-length` check in `readJsonBody` is best-effort (`Number(garbage)` is `NaN`,
     `NaN > X` is `false`) and is backed by the streaming check — a comment so a later refactor does not lean
     on it as the only guard (`src/http-transport.ts:210`).

---

## 6. What the handoff does not mention, that a 0.5.2 user would be surprised by

Ranked by how likely it is to bite.

1. **The server now writes named, hidden, permanent report objects into the network.** `gam-mcp <hash>`, one
   per distinct query, created hidden and undeletable through the API. The handoff mentions this only for the
   *smoke script*; it is true of every report tool call in normal operation. A network admin who looks will
   find these and have no way to remove them.
2. **Startup now fails where 0.5.2 started.** Five new startup-stopping conditions, each exit code 2:
   unreadable network / bad credential; non-numeric `GAM_NETWORK_CODE`; an unknown **or offset**
   `GAM_TIMEZONE`; any of the four integer settings not digits-only; an unusable `GAM_REPORT_CACHE_DIR`; a
   busy `GAM_HTTP_PORT`. A container that started and reported healthy on 0.5.2 with a broken key now exits
   before serving. That is the point (F20), but it is an upgrade-day surprise.
3. **`GAM_TIMEZONE` unset changes meaning**, from UTC to the network's own zone. Covered by footer #3, but
   the practical effect — "yesterday" resolves to a different date for anyone who left it unset — deserves
   a sentence of its own.
4. **`AMBIGUOUS_NAME`**: queries that used to return numbers now return an error (`8a38ee7`). Not in the
   handoff, not in spec §6, not in any footer.
5. **Local report-query validation** (`ae210b2`): a `run_report` with a dimension or metric the derived
   report type does not offer is refused locally instead of being forwarded. Combined with the known PR-4
   gap (filter field names are not alias-resolved), a filter on an aliased dimension name is refused
   although the dimension itself is accepted — a user could read that as a regression.
6. **The 1 MiB HTTP body limit** (`dcc7e36`) — new, and HTTP mode had none before.
7. **Result JSON key order changed** and every result now carries `warnings` that 0.5.2 never produced
   (zone-difference warnings, live-value warnings, page caveats). Anything consuming the output positionally,
   or asserting on it, changes.
8. **`gam://network` renamed a key** (`timezone` → `report_time_zone` + `date_time_zone`). In footer #8, but
   buried behind the saved-query headline in the same footer — easy to miss.
9. **Saved queries vanish in HTTP mode.** In footer #8. Worth stating in the README's tool table too, since a
   user running HTTP simply sees four tools missing with no explanation.

---

## 7. Suggested commit split for PR 5

Conventional Commits; **no `Co-Authored-By`, no AI-attribution footer** (repo `CLAUDE.md` lines 34-35).

1. `fix(zones): say which part of a report's time zone this server cannot use` — §4 (code + the two test
   files).
2. `docs(readme): configuration, paging, caching and the HTTP boundary as 0.6.0 ships them` — §1.
3. `docs(spec): offset time zones are breaking; correct the pending-entry and truncated rules` — §2.
4. `docs: record a per-request GAM timeout as a post-0.6.0 follow-up` — §5.
5. `docs: rewrite CLAUDE.md's stale sections against the shipped architecture` — spec §8 item 5 requires
   this and neither the handoff nor this scope has covered it; `CLAUDE.md`'s closing section explicitly asks
   for it once code lands (real commands, the chosen GAM API flavour, the transport/auth/tool-registry
   architecture).
6. The CHANGELOG preamble (§3) is **not** a PR 5 commit — it is an edit to release-please's own release PR,
   made after the stack merges.
