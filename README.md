# gam-mcp

Read-only MCP server for **Google Ad Manager** analytics. Lets an LLM (Claude Desktop, Claude Code, any MCP client) answer real publisher questions — *what's revenue WoW, which line items are under-pacing, what's our fill rate by buyer network, which ad units drove yesterday's revenue* — without writing report builders by hand.

29 tools over HTTP, 33 over stdio (stdio adds 4 saved-query tools that HTTP does not register) — descriptive ("what is happening"), comparative ("compared to what"), and diagnostic ("what's at risk") analytics. Generic across publishers — no per-network assumptions baked in.

## What's new in 0.6.0

A correctness release for the analytics tools. The shared report path, the result cache and the
tool-input contract were rewritten.

- **Reports are reused, not redefined.** A report is named after the hash of its definition, so an
  identical query reuses the one already in the network instead of defining another. Results are
  cached in memory, and optionally on disk so reuse survives a restart.
- **Large results are paged, not buffered.** `fetch_report_page` walks a result with a cursor;
  every page carries the same provenance.
- **Every result explains itself.** A `provenance` block names the report and result, the run time,
  the resolved date range, the network's reporting time zone *and* the zone dates were chosen in,
  the currency, and whether the cache was hit.
- **Computed numbers are labelled as computed.** Anything the server derives rather than reads from
  GAM sits under a `derived` object carrying its `method`, `inputs`, and whether a heuristic was
  used — so a caller can tell a measurement from an estimate.
- **Unknown tool arguments are refused by name.** A typo or a stale field returns `INVALID_INPUT`
  naming the key instead of being silently dropped.
- **Ranked tools really rank.** `top_n` sorts by the metric in the summary and caps the rows.
- **Entity rows carry IDs beside names,** so two entities sharing a display name no longer merge
  into one row.
- **Bad configuration fails at startup, not on the first query** — the credential and network code
  are checked before any tool is served, and a `GAM_TIMEZONE` that isn't a real IANA zone is
  refused rather than silently misinterpreted.
- **Ambiguity is an error.** A name matching more than one entity returns `AMBIGUOUS_NAME` with the
  candidates, instead of silently picking the first.
- **An optional HTTP transport** with a Host allowlist, optional bearer token, and a request body
  limit.

0.6.0 contains breaking changes — see the [CHANGELOG](CHANGELOG.md) for the full list, and the
upgrade notes in **Configuration** and **Troubleshooting** below.

## Install

You don't. Add it to your MCP client config and let `npx` fetch it on first use.

## Setup

1. **Provision a service account** in Google Cloud Console with Ad Manager API access:
   - Create a project (or pick one).
   - Enable the Google Ad Manager API.
   - Create a service account, generate a JSON key, download it.
   - In Ad Manager (UI): **Admin → Access & authorization → API access**, add the service account email and grant it the read role you need (e.g., "Reports user" or higher).
2. **Add to your MCP client config**:

   **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
   ```jsonc
   {
     "mcpServers": {
       "google-ad-manager": {
         "command": "npx",
         "args": ["-y", "gam-mcp"],
         "env": {
           "GAM_NETWORK_CODE": "1234",
           "GAM_SERVICE_ACCOUNT_KEY_FILE": "/Users/me/secrets/gam-sa.json",
           "GAM_TIMEZONE": "Asia/Tokyo"
         }
       }
     }
   }
   ```

   **Claude Code** — add the same `mcpServers` block to `.mcp.json` at your project root or to your global Claude Code config.

   **Alternative credential sources** — if mounting a key file isn't convenient (containers, hosted MCP), use one of:
   ```jsonc
   // inline JSON (raw or base64-encoded)
   "env": { "GAM_NETWORK_CODE": "1234",
            "GAM_SERVICE_ACCOUNT_KEY_JSON": "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Ii4uLn0=" }
   ```
   ```jsonc
   // Application Default Credentials — no key vars needed
   // (works on GCE/Cloud Run, or locally after `gcloud auth application-default login`)
   "env": { "GAM_NETWORK_CODE": "1234" }
   ```

3. Restart your MCP client.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GAM_NETWORK_CODE` | yes | — | Numeric network code |
| `GAM_SERVICE_ACCOUNT_KEY_FILE` | one-of | — | Absolute path to service-account JSON. Wins over `GAM_SERVICE_ACCOUNT_KEY_JSON` if both are set. |
| `GAM_SERVICE_ACCOUNT_KEY_JSON` | one-of | — | Service-account JSON inline, either as raw text or base64-encoded. Useful in hosted environments (Cloud Run, Fly, Render) where mounting a key file is awkward. Eagerly parsed at startup — a malformed value fails fast. |
| _(none of the above)_ | one-of | — | Falls back to **Application Default Credentials**. Picks up `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login` tokens, or the GCE/Cloud Run metadata server. |
| `GAM_TIMEZONE` | no | the network's own time zone | IANA name choosing which calendar dates are requested. It does **not** change the zone GAM counts days in — every report is sent with `timeZoneSource: PUBLISHER`, so GAM always counts days in the network's zone. Both zones appear separately in every result's `provenance` and on `gam://network`. An unrecognized IANA name, or a raw UTC offset (e.g. `+08:00`), stops startup with exit code 2. |
| `GAM_PAGE_ROWS` | no | 5000 | Rows returned per page of report results, clamped to 10000 (values above the cap are used as 10000 and logged once as `config.page_rows_clamped`). A value that isn't a positive integer stops startup. Replaces `GAM_INLINE_ROW_THRESHOLD`, which is no longer read — if set, startup logs `config.ignored` once (`reason: "results are paged; set GAM_PAGE_ROWS instead"`) and continues. |
| `GAM_REPORT_TIMEOUT_MS` | no | 300000 | Max time to poll one report job, in milliseconds — digits only (`3e5`, `5.0`, `-1`, `" 5"` all stop startup). Set it below your MCP client's call timeout. On timeout the GAM job is **not** abandoned: the next identical call resumes the same operation instead of starting a new one. |
| `GAM_LOG_LEVEL` | no | `info` | One of `error`, `warn`, `info`, `debug`. Logs are JSON-lines on stderr — tool calls, GAM retries, report-job lifecycle, cache hits. Credentials are never logged. |
| `GAM_SAVED_QUERIES_FILE` | no | `${XDG_CONFIG_HOME:-$HOME/.config}/gam-mcp/saved-queries.json` | Path to the saved-query JSON store used by `save_query` / `run_saved_query`. **stdio mode only** — HTTP mode does not register the saved-query tools. Override when running multiple instances per machine or for testing. |
| `GAM_REPORT_CACHE_DIR` | no | _(off — in-memory only)_ | When set, stores a **reference to each report result** — report name, result name, row count, run time, never rows — as one JSON file per entry, at `<dir>/<network code>/<64-character hex definition hash>.json`, in a directory created with mode `0o700`. Survives MCP restarts. |
| `GAM_REPORT_CACHE_TTL_MS` | no | 3600000 (1h) | How long a cached result reference is reused, in milliseconds — applies to **both** the in-memory and disk tiers. `0` disables result reuse entirely. |
| `GAM_HTTP_PORT` | no | _(off — stdio mode)_ | When set, the MCP listens for Streamable-HTTP requests on this port at `POST /mcp` (with `GET /healthz` for probes), instead of stdio. Digits only, 1–65535. Use for hosted/team deployments. |
| `GAM_HTTP_BEARER_TOKEN` | no | _(off)_ | HTTP mode only — see the HTTP transport notes below. |
| `GAM_HTTP_ALLOWED_HOSTS` | no | _(off — no Host check)_ | HTTP mode only — see the HTTP transport notes below. |

### Report cache

`GAM_REPORT_CACHE_DIR` adds a disk tier on top of the in-process one. Each distinct report definition gets its own file at `<dir>/<network code>/<64-character hex definition hash>.json`, holding a **reference** to the GAM result that answered it — the report name, the result name, the run time, the date range GAM computed, and the row count — never report rows. Rows are always fetched fresh from GAM on every call, cache hit or not; only the pointer to which result to read is what gets reused.

Nothing sweeps the directory on a schedule. The in-process tier is bounded (an LRU of 1000 entries), but the disk tier is not — it grows by roughly one small file per distinct query shape you run, indefinitely, unless something removes it. The only automatic removal is per-entry and happens on access: a file is re-read the next time its own definition is requested, and if `GAM_REPORT_CACHE_TTL_MS` has passed by then, that read deletes it and gam-mcp runs the report again. A file this server can't make sense of — one that fails to parse, or names another network's report — is simply ignored on every read; it is left in place, not deleted. Deleting the whole directory, or any file in it, is safe at any time: the worst case is a handful of reports being re-run on the next matching call.

Upgrading from 0.5.x: that version's disk cache wrote gzip-compressed row dumps directly into `GAM_REPORT_CACHE_DIR` (`<sha256-of-key>.json.gz`, one level, no per-network subdirectory). 0.6.0 writes into a `<network code>/` subdirectory instead and only ever opens the exact `.json` path its own hash names — it never lists the directory — so it will neither read nor delete those old `.json.gz` files. They just sit there, inert. Delete the directory when you upgrade if you want the space back; nothing breaks if you don't.

`provenance.cache.hit` on a report's first page means that call obtained its result from the cache tier instead of starting (or resuming) a fresh GAM report job. A page fetched with `fetch_report_page`, though, always reports `cache.hit: false` — even when the result it is paging through was itself served from cache on the call that produced the cursor. Fetching a further page never re-enters the cache lookup at all; it fetches the next page of an already-open result directly. Read `cache.hit` as "this call's own first page came from the cache," not as a property of the underlying result.

### HTTP transport

Setting `GAM_HTTP_PORT` switches the server from stdio to Streamable HTTP: requests go to `POST /mcp` (`GET /healthz` for liveness probes) on that port instead of the MCP frames going over stdio.

- **`GAM_HTTP_BEARER_TOKEN`** — when set, every request to `/mcp` must carry `Authorization: Bearer <token>`; a missing or wrong token is refused `401`. `/healthz` deliberately skips this check, so a probe that only reaches the container directly still works. Leaving the token unset does not stop the server from starting: it logs `http.unauthenticated` once at startup and then serves every request to `/mcp` with no authentication at all.
- **`GAM_HTTP_ALLOWED_HOSTS`** — a comma-separated list of host names (no ports). A request whose `Host` header names anything else is refused `403`, checked before the bearer token. Leave it unset and there is no Host check at all.
- **Body size** — a request body over 1 MiB is refused `413`, whether that is obvious from `Content-Length` up front or only discovered once the body is already streaming in.
- **A busy port** — if `GAM_HTTP_PORT` is already bound by something else, startup stops with **exit code 2** and a message naming the variable and the port (`GAM_HTTP_PORT <port> is already in use by another process`), instead of the server half-starting. 0.5.2 didn't handle this at all: the same situation surfaced as an unhandled error, and the process exited 1 with a raw stack trace instead of a message naming the cause.

## Tools

| Tool | Purpose |
|---|---|
| **Descriptive** | What's happening |
| `revenue_summary` | Total revenue/impressions, optionally grouped by day/week/month/advertiser/order/line_item/ad_unit/country/device/line_item_type |
| `top_advertisers`, `top_line_items` | Top-N by revenue or impressions, with context |
| `kv_breakdown` | Top values of a publisher-configured custom-targeting key, by revenue or impressions, optionally narrowed to one ad unit / order / line item. Requires the key's ID — discover it via `lookup(entity_type="custom_targeting_key")`. |
| `inventory_breakdown` | Programmatic vs direct vs house split by `line_item_type`, `advertiser`, or `order` |
| `revenue_trend` | Time series at day/week granularity, optionally split by one dimension |
| `fill_rate` | Fill-rate funnel by ad_unit / device_category / country / day |
| `pacing_status` | Current-period delivery per line item (note: pacing % vs goal not directly available — use `find_anomalies`) |
| `bidder_breakdown` | Open Bidding (EBDA) yield by bidder — AdX impressions, revenue, average eCPM per `BIDDER_NAME`. Optional secondary slice by day / ad_unit / country / device / line_item_type. |
| `yield_breakdown` | Yield-group (Open Bidding / mediation) yield — impressions, estimated revenue, estimated eCPM, mediation fill rate, and passbacks per partner (`by:"buyer"`) or per group (`by:"yield_group"`). Ranks Open Bidding partners to prune the waterfall. Optional secondary slice by day / ad_unit / country / device. |
| `video_breakdown` | Video completion funnel — starts → 25% → 50% → 75% → completes + completion rate, by ad_unit / placement type / size / duration. Optional secondary slice by day / country / device. |
| `viewability_breakdown` | Active View viewability — viewable / measurable / eligible impressions + viewable & measurable rates, by ad_unit / size / device. Optional secondary slice by day / country / device. |
| `reach_report` | Unique audience and delivered frequency from GAM's **Reach** report type — total unique visitors (deduplicated people, not cookies), total reach impressions, and average impressions per unique visitor, by line_item / order / advertiser / ad_unit, optionally sliced by country or day and filtered to specific IDs. Use it to size a frequency cap from what a campaign actually delivered. Reach metrics come from a separate GAM report type, so they can't be mixed with revenue/impression metrics; unique counts are **not additive** across rows. Ad-server/reservation delivery only (excludes AdX and AdSense), ~3-day lag, ~1-year retention. |
| `ad_speed` | Ad latency and page-speed diagnostics (`AD_SPEED` report type) — the distribution of impressions across creative load-time buckets (0–500 ms → >8 s), the page/tag timing funnel, or the reasons impressions went unviewed, by ad_unit / device / country / creative size. The causal answer behind low viewability, where `viewability_breakdown` only shows the symptom. Buckets are percentages that sum to ~100% per row, so `IMPRESSIONS` rides along as the volume denominator. |
| `sell_through` | Forward-looking inventory availability (`FUTURE_SELL_THROUGH` report type) — forecasted, reserved, and available impressions plus sell-through rate (reserved ÷ forecasted; ≥1.0 means oversold), by ad_unit / placement / line_item / order over a **future** date range, optionally filtered to specific IDs. The forward half of `pacing_status`: that shows a line item is behind, this shows whether the inventory to catch it up exists. Forecasts, not measurements. |
| `consent_messaging` | Privacy and user-messaging performance (`PRIVACY_AND_MESSAGING` report type) — messages shown and how users responded, one family at a time via `focus`: EU/UK consent, ad-blocking recovery, Apple ATT, US state opt-outs, ads-personalization (UPTC), or offerwall. Optional slice by day / country / device / OS group / app. Every message type is independently optional, so all-zero means "not configured" as often as "no traffic". |
| `find_unused_ad_units` | "Codeless" ad units — those that received fewer than `min_requests` ad requests over the lookback window. Computes a set-difference between every ad unit and ad units that appeared in a report. |
| **Comparative** | Compared to what |
| `compare_periods` | Run any report twice and get per-row deltas — WoW, MoM, YoY, or explicit. Output rows carry `<metric>`, `<metric>_prev`, `<metric>_delta_pct`. |
| **Diagnostic** | What's at risk |
| `find_anomalies` | Four kinds: `pacing_underdelivery` (line items below pro-rated MTD pace), `fill_rate_drops` (ad units with WoW fill-rate drops, threshold in pp), `ecpm_regression` (buyer networks whose AdX eCPM dropped WoW, threshold as % of prior), `viewability_drops` (ad units whose Active View rate dropped WoW, threshold in pp). |
| `diagnose_floor_pricing` | Infer AdX floor-price effectiveness per ad unit from the match-rate × eCPM relationship vs the network median. Verdicts: `floor_likely_high` (low match / high eCPM — sacrificing fills for price), `floor_likely_low` (high match / low eCPM), `weak_demand`, `balanced`. Carries an upper-bound `est_opportunity`. Inferred, not a UPR readout — GAM REST exposes no floor value. |
| `diagnose_fill_rate` | Explain **why** ad units have low fill. Runs the AdX funnel report (requests → routed to AdX → AdX match → ad-server response → unfilled) + WoW comparison, then attributes a single primary cause per row: `healthy`, `tag_integration`, `demand_collapse`, `low_match_rate`, `direct_underdelivery`, `no_demand`, or `mixed`. Ranks by unfilled-impression volume for impact-aware results. |
| **Power tools** | The escape hatches |
| `run_report` | Generic GAM Reports query — pick any dimensions/metrics from `describe_schema`, optional filters (`=`, `IN`, `!=`, `CONTAINS`, `NOT_CONTAINS`), optional `custom_dimension_key_ids` for KV reporting |
| `fetch_report_page` | Fetch the next page of rows from a result any other report tool returned, by passing back its `next_cursor`. The cursor is not a credential of its own — it just names a result the same service account could reproduce by running the report again, so it grants nothing new. |
| `kv_report` | High-level KV-narrowed report: give `kv="key=value"`, a date range, and metrics; resolves the key via lookup and runs a report scoped to that value, compatible with request-time and AdX/AdSense metrics GAM normally forbids alongside `KEY_VALUES_NAME`. Optionally narrows by ad_unit / order / line_item. Page 1 describes its filter as `kv=<key>=<value>`; a further page fetched with `fetch_report_page` describes the same filter generically as `CUSTOM_DIMENSION_N_VALUE = <value>` instead, since `fetch_report_page` only has the stored wire definition and can't recover the key name — both are correct. |
| `lookup` | Name ↔ ID resolution for advertisers, orders, line items, ad units, placements, companies, **custom_targeting_keys**. Lists up to 1000 with transparent pagination. |
| `describe_line_item` | Read a line item's **configuration** rather than its delivery — status, flight dates, type/priority, rate and goal, frequency caps, delivery and rotation settings, creative placeholders, and `targeting`. Custom targeting is flattened to readable clauses (`IS ANY OF` / `IS NONE OF`, clauses OR'd, literals within a clause AND'd) and every GAM resource path in the targeting — custom targeting keys and values, ad units, placements — is resolved to its API code and display name. No reporting dimension exposes a targeting expression, so this is the only way to see what a line item targets instead of inferring it from delivery. 1–50 ids per call. **Returns commercially sensitive fields verbatim — rate, cost type, and delivery goal among them — so an operator exposing this MCP to a shared or multi-tenant agent may want to gate or withhold this tool.** |
| `describe_schema` | Browse the dimensions and metrics this MCP can query — **the complete GAM REST enum: 764 dimensions and 526 metrics.** Filter with `report_type` (what can legally appear in one request together), `family` (name prefix, e.g. `AD_EXCHANGE`), or `search` (substring of name or description). Unfiltered calls return names and types only; any filter turns on descriptions, report-type compatibility, and the curated `incompatible_with` hints |
| **Saved queries** | Templates the analyst can stash and replay |
| `save_query` | Persist a `run_report`-shaped template (dimensions + metrics + optional filters + custom_dimension_key_ids) under a name. Date range is deliberately not saved — supply it fresh at replay. |
| `list_saved_queries` | List every saved template with name, description, and save timestamp. |
| `run_saved_query` | Replay a saved template against a fresh `date_range`. Equivalent to `run_report` with the saved fields merged in. |
| `delete_saved_query` | Delete a saved template by name. |
| **Operations** | Diagnose the MCP itself |
| `health_check` | End-to-end probe — verifies auth + network + permissions by listing one company. On failure, returns `isError: true` naming the failing check and an attributed cause (auth / permission / network / quota / wrong-network) — 0.5.2 returned a successful envelope with `status: "failed"` instead. Use after setup or when the LLM hits mysterious errors. |
| `usage_stats` | Session-to-date counters: GAM API calls by type, report-job count, cumulative report latency, cache hits/misses with hit-rate. Lets the LLM self-pace and the analyst spot redundant work. |

## Resources

The server also advertises an MCP `resources` capability so the LLM (or client UI) can browse the curated schema without spending a tool call:

| URI | Content |
|---|---|
| `gam://schema` | Full curated dimension + metric catalog with descriptions. |
| `gam://schema/dimensions` | Dimensions only. |
| `gam://schema/metrics` | Metrics only. |
| `gam://network` | The configured network's identity: `network_code`, `currency_code`, `report_time_zone` (the zone GAM counts report days in), and `date_time_zone` (`GAM_TIMEZONE` — the zone dates are chosen in). |

## Prompts

The server ships preset workflows under the MCP `prompts` capability. These show up as user-invokable templates in clients that surface prompts (e.g. Claude Desktop):

| Prompt | Arguments | Purpose |
|---|---|---|
| `weekly_pacing_review` | `top_n` (opt, default 20) | Pacing + fill-rate + eCPM + viewability anomalies for the past week, with a "top 3 to fix" summary. |
| `monthly_revenue_close` | `month` (opt, `YYYY-MM`) | Close-of-month revenue: total, mix, top advertisers, YoY comparison. Defaults to last full month. |
| `fill_rate_postmortem` | `lookback_days` (opt, default 14), `ad_unit_query` (opt) | Investigate a fill-rate drop: enumerate affected ad units, quantify lost revenue, identify likely cause. |

## Example queries

Things an LLM with this MCP attached can answer directly. (No prompts engineering required — just ask.)

1. **WoW revenue check.** *"How does last week's revenue compare to the week before?"* → `compare_periods({dimensions:["DATE"], metrics:["REVENUE"], base_range:{relative:"last_7_days"}, comparison:"previous_period"})`.
2. **Programmatic vs direct mix.** *"What's the demand-channel breakdown for the last 30 days, with eCPM per channel?"* → `inventory_breakdown` plus a `run_report` slice on `LINE_ITEM_TYPE`.
3. **Buyer network share.** *"Which DSPs spend the most on us?"* → `run_report({dimensions:["BUYER_NETWORK_NAME"], metrics:["AD_EXCHANGE_REVENUE","AD_EXCHANGE_AVERAGE_ECPM"], date_range:{relative:"last_7_days"}})`.
4. **Pacing risk.** *"Which line items are under-pacing this month?"* → `find_anomalies({kind:"pacing_underdelivery", top_n:20})`.
5. **Fill-rate regression.** *"Did any ad units have a fill-rate drop this week?"* → `find_anomalies({kind:"fill_rate_drops", threshold_pct:5})`.
5a. **eCPM regression.** *"Which DSPs are paying us less this week than last?"* → `find_anomalies({kind:"ecpm_regression", threshold_pct:10})`.
5b. **Viewability regression.** *"Any ad units where viewability tanked?"* → `find_anomalies({kind:"viewability_drops", threshold_pct:5})`.
5d. **Fill-rate root cause.** *"Why is the homepage_top ad unit only filling 30%?"* → `diagnose_fill_rate({ad_unit_query:"homepage_top"})`. Returns funnel-position ratios with an attributed cause per row.
5c. **Open Bidding yield.** *"Which Open Bidding bidders drove the most revenue last week, and on which devices?"* → `bidder_breakdown({date_range:{start:"2026-05-04", end:"2026-05-10"}, group_by:"device"})`.
5e. **Yield-group waterfall health.** *"Which Open Bidding partners have low fill and high passbacks?"* → `yield_breakdown({date_range:{start:"2026-05-04", end:"2026-05-10"}, by:"buyer"})`.
5f. **Video drop-off.** *"Where do viewers abandon my video ads by placement type?"* → `video_breakdown({date_range:{start:"2026-05-04", end:"2026-05-10"}, by:"placement"})`.
5g. **Low-viewability inventory.** *"Which ad sizes have the worst viewable rate?"* → `viewability_breakdown({date_range:{start:"2026-05-04", end:"2026-05-10"}, by:"size"})`.
5i. **Frequency cap from evidence.** *"What frequency cap should this direct campaign use?"* → `reach_report({date_range:{start:"2026-05-01", end:"2026-05-31"}, by:"line_item", ids:[<line_item_id>]})` — returns unique visitors and the average impressions each one already received, so the cap is set against observed frequency instead of a guess.
5j. **Slow ads, not bad placements.** *"Viewability is poor on mobile — is it the placement or the page?"* → `ad_speed({date_range:{start:"2026-05-04", end:"2026-05-10"}, by:"device", focus:"unviewed_reason"})`. A high "scrolled before ad loaded" share is a speed problem; "slot never entered viewport" is a placement problem.
5k. **Can we take the booking?** *"An advertiser wants 5M impressions next month — do we have it?"* → `sell_through({date_range:{start:"2026-06-01", end:"2026-06-30"}, by:"ad_unit"})` and read `available impressions`.
5l. **Cost of consent.** *"What share of EU users consent, and how does that vary by country?"* → `consent_messaging({date_range:{start:"2026-05-01", end:"2026-05-31"}, focus:"eu_consent", group_by:"country"})`.
5h. **Floors set too high.** *"Where are my AdX floors costing me fills?"* → `diagnose_floor_pricing({lookback_days:7})` — surfaces `floor_likely_high` ad units ranked by recoverable revenue.
6. **Specific ad units.** *"Revenue and impressions for our Nimbus placements last week."* → `run_report` with `filters:[{field:"AD_UNIT_NAME", op:"CONTAINS", value:"Nimbus"}]`.
7. **AdX yield diagnosis.** *"AdX match rate and average eCPM per ad unit yesterday."* → `run_report({dimensions:["AD_UNIT_NAME"], metrics:["AD_EXCHANGE_TOTAL_REQUESTS","AD_EXCHANGE_MATCH_RATE","AD_EXCHANGE_AVERAGE_ECPM"], date_range:{relative:"yesterday"}})`.
8. **Custom dimension breakdown.** *"Revenue by section."* → first `lookup({entity_type:"custom_targeting_key", query:"section"})` to find the key ID, then `run_report({dimensions:["CUSTOM_DIMENSION_0_VALUE"], metrics:["IMPRESSIONS","REVENUE"], date_range:{relative:"last_7_days"}, custom_dimension_key_ids:[<that_id>]})`.
9. **YoY comparison.** *"How does last month's revenue compare to the same month last year?"* → `compare_periods({base_range:{relative:"last_full_month"}, comparison:"previous_year", dimensions:["DATE"], metrics:["REVENUE"]})`. (`month_to_date` works too, except on the first day of a month, when there's no complete day yet to report — it returns `INVALID_DATE_RANGE`; `last_full_month` avoids that edge case entirely.)
10. **Top advertisers in a country.** *"Top advertisers in Germany this month."* → `top_advertisers` with a `COUNTRY_NAME` filter.

## Schema notes

- **`describe_schema`** returns the full GAM catalog. Read it before composing `run_report` queries — but **filter it**: 1290 entries with prose will swamp a context window. `describe_schema({report_type:"REACH"})` or `describe_schema({search:"viewab"})` is almost always what you want.

### Schema provenance

`src/schema-generated.ts` is generated from Google's [`report_definition.proto`](https://raw.githubusercontent.com/googleapis/googleapis/master/google/ads/admanager/v1/report_definition.proto) — it is the complete REST `Metric`, `Dimension`, and `ReportType` enums, including each entry's report-type compatibility and its data format (which determines whether a metric reads as a count, a currency, or a rate). Hand-written descriptions and the observed incompatibility matrix live in `src/schema-overrides.ts` and are merged over the generated entries, so regenerating never destroys curated prose.

```bash
npm run refresh-schema   # regenerate src/schema-generated.ts from the proto
npm run schema:gap       # diff generated vs whitelisted; flags drift both ways
```

`schema:gap` reports names GAM has that we lack **and** names we whitelist that GAM no longer declares. The second direction matters more: a whitelisted-but-nonexistent name passes local validation and then fails against the live API.

### Report types

GAM runs each report family as a distinct `reportType`, and a request is wholly one type. This server derives the type by intersecting the report types every requested dimension and metric accepts, so callers never pass it — and asking for, say, reach and historical metrics together is rejected locally with a message naming which side wants which type, instead of a generic GAM 400.

`HISTORICAL` and `REACH` have purpose-built tools. The other ten types in the enum are reachable through `run_report` (their metrics are whitelisted) but are forwarded unverified — you'll get a warning on the envelope saying so.
- **`KEY_VALUES_NAME` overlap caveat:** one impression can match multiple key-value pairs, so summing impressions/revenue across rows OVERSTATES the true total. Use it to *rank* active KVs, not for share-of-total math. For clean aggregation, use `CUSTOM_DIMENSION_<N>_VALUE` with `custom_dimension_key_ids` — those slots are mutually exclusive (one value per request).
- **`CUSTOM_DIMENSION_<N>_VALUE` is publisher-configured.** Slot 0 means whatever your network admin has mapped to it (might be `section`, might be `tier`, might be unused). Discover via `lookup(entity_type="custom_targeting_key")`.
- **No EQUALS in GAM.** The `=` and `!=` filter ops are aliases the MCP translates to `IN`/`NOT_IN` with a single value. Substring search uses `CONTAINS`/`NOT_CONTAINS` (literal substring, no wildcards).
- **`AD_REQUESTS` and `UNFILLED_IMPRESSIONS` can't be sliced by `LINE_ITEM_TYPE`** — those metrics live at the request stage before any line item is selected. Use them at the network or ad-unit level only.

## Reliability

- **Retries** — automatic exponential backoff on 429/5xx and network errors (4 attempts, 250ms base + jitter). 4xx surfaces immediately.
- **Pagination** — `lookup` transparently pages through GAM's 200-per-page responses up to your requested `limit` (max 1000).
- **Report cache** — an identical report definition (same dimensions, metrics, filters, sort, and resolved date range) reuses a previously obtained GAM result instead of running a fresh report job. What's reused is a **reference** to that result, never the rows themselves — every call still fetches its own pages from GAM. Reuse has a **TTL of one hour by default** (`GAM_REPORT_CACHE_TTL_MS`), applied to both the in-process tier and the optional on-disk tier (see [Report cache](#report-cache) above); `0` turns reuse off entirely.
- **Every report tool leaves a report object behind in your GAM network.** Before gam-mcp can read a result, it defines a report for the exact query it is about to run via the GAM REST API. That report is created `HIDDEN` (it never appears in the Ad Manager UI), and the REST API gives gam-mcp no way to delete it. gam-mcp names each report after the SHA-256 hash of its own definition — dimensions, metrics, filters, sort, **and the resolved date range** — and reuses that same object for every later call whose hash matches; the count in your network is bounded by the number of distinct (query shape, resolved date range) combinations you've asked for, not by the number of calls, but that count never goes back down. Because the resolved date range is part of the hash, a tool queried with a fixed `date_range` defines at most one report per shape, while a rolling window (e.g. "last 7 days", run daily) resolves to a different start/end every day and so defines a new report every day it runs. **Four tools cannot be pinned to a fixed window at all:** `find_unused_ad_units`, `diagnose_fill_rate`, and `diagnose_floor_pricing` take only `lookback_days` (no `date_range` field in their input), and `find_anomalies` takes no window input whatsoever — it always uses a hardcoded 7-day lookback. Calling any of those four on a recurring schedule (e.g. a daily cron) defines one new hidden report per tool, every day, forever. This is a permanent, cumulative footprint on whichever network gam-mcp is pointed at — worth knowing before you point it at one, not after.

## Troubleshooting

- **"AUTH_FAILED"** — verify `GAM_SERVICE_ACCOUNT_KEY_FILE` path is readable and the service account has API access in the Ad Manager UI.
- **"REPORT_TIMEOUT"** — narrow the date range, or set `GAM_REPORT_TIMEOUT_MS=900000` for 15 minutes. GAM is still running the job: it is not abandoned on timeout, so calling the same tool with the same input again resumes waiting on that same operation instead of starting a second one.
- **"REPORT_ERROR_CONSTRAINTS_INCOMPATIBILITY"** — some dimension/metric combos are forbidden by GAM (e.g., `AD_REQUESTS` × `LINE_ITEM_TYPE`). Split into separate queries.
- **"REPORT_ERROR_MISSING_DYNAMIC_DIMENSION_ID_AT_INDEX"** — you queried `CUSTOM_DIMENSION_<N>_VALUE` without supplying `custom_dimension_key_ids[N]`. Look the key ID up via `lookup(entity_type="custom_targeting_key")`.
- **"INVALID_DATE_RANGE"** on a period-to-date range (`month_to_date`, `quarter_to_date`, `year_to_date`) — on the first day of that period there is no complete day yet to report. Use an explicit `{start, end}` range, or a range that names a prior complete period (e.g. `last_full_month`), or retry after that day has ended.
- **"AMBIGUOUS_NAME"** — a name-based lookup (an advertiser, order, line item, ad unit, or custom targeting key) matched more than one entity; 0.5.2 silently took the first match, 0.6.0 refuses. Inspect `details.candidates` in the error and re-run with a specific numeric ID instead of the name.
- **"DUPLICATE_JOIN_KEY"** — `compare_periods` found two rows in the same period that reduce to the same join key, so it can't tell which one the other period's row should be compared against. Add a more granular dimension (e.g. an ID rather than just a name) so each row's key is unique.
- **"RESULT_TOO_LARGE"** — the report has more rows than this call can return: over 50,000 rows for a tool that reads a whole report into memory (e.g. `find_anomalies`), or more than the configured page size for a paged result. Narrow the date range, add filters, or request fewer dimensions.
- **"REPORT_RESULT_EXPIRED"** — GAM no longer serves the report result a `fetch_report_page` cursor (or a reused report) pointed at; GAM keeps report results for a limited time. Re-run the original tool call — not `fetch_report_page` — and it will run the report afresh.
- **Startup stops with exit code 2** — several conditions do this, each named on stderr: a missing or non-numeric `GAM_NETWORK_CODE`; an unrecognized `GAM_TIMEZONE` (or a raw UTC offset instead of an IANA name); a non-numeric/out-of-range `GAM_REPORT_TIMEOUT_MS`, `GAM_REPORT_CACHE_TTL_MS`, or `GAM_PAGE_ROWS`; a `GAM_REPORT_CACHE_DIR` whose directory can't be created; an invalid `GAM_HTTP_PORT`, `GAM_HTTP_BEARER_TOKEN`, or `GAM_HTTP_ALLOWED_HOSTS`; a `GAM_HTTP_PORT` already in use by another process; or a credential that can't authenticate or read the configured network. Fix the named variable and restart.
- **"`gam-mcp: GAM_NETWORK_CODE is required`"** — the env var didn't make it into the subprocess. Check your MCP client config's `env` block.
- Logs go to **stderr**, not stdout. If your MCP client is hiding them, check its log file.

## Development

```bash
git clone <this repo>
cd gam-mcp
npm install
npm test                # unit tests with synthetic fixtures; no credential needed
npm run build           # tsc → dist/
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run smoke
                        # opt-in: hits real GAM end-to-end, through the library
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... \
  npm run smoke:transports -- --yes
                        # opt-in: drives the packaged dist/cli.js over BOTH
                        # stdio and HTTP, then repeats the run in a fresh
                        # process to prove report reuse works across processes
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... \
  npm run smoke:transports -- --yes --define-ad-unit-report
                        # opt-in (separately from --yes): also calls
                        # find_unused_ad_units once, over stdio, to check its
                        # AdUnit field names against the live API. This
                        # DEFINES A NEW HIDDEN, UNDELETABLE REPORT every
                        # distinct calendar day it runs (see below), so it is
                        # not part of a routine smoke run
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run verify:pack
                        # release gate: pack tarball, install in tempdir,
                        # exercise the bin as a real MCP client would
```

`smoke:transports` refuses to start without `--yes`: it runs against a live network and **defines a report
object, which the Ad Manager API creates hidden and cannot delete**. It uses one fixed date range for every
run so it only ever defines one such report — later runs find that report again instead of adding another.
Override `GAM_SMOKE_DATE_START` / `GAM_SMOKE_DATE_END` if GAM has aged that window out of retention.

With `--define-ad-unit-report` (or `GAM_SMOKE_DEFINE_AD_UNIT_REPORT=yes`), it also exercises
`find_unused_ad_units` once, on the stdio run only. That tool filters on `AdUnit.status === 'ACTIVE'` and
derives leaf ad units from `AdUnit.parentAdUnit`, and neither field name was ever confirmed against the
live API — no unit test can confirm a live API's field spelling, because every fixture is written by
whoever wrote the code reading it. Because a missing `status` is treated as not-active, a wrong field name
fails *totally*, not partially: every ad unit gets excluded and the tool returns zero rows on every call,
silently, forever. The smoke script fails loudly on exactly that signature — ad units listed and every one
excluded — while still passing on a network with genuinely no ad units.

This check is a **separate opt-in from `--yes`**, not part of a routine smoke run, because it is
unavoidably expensive: `find_unused_ad_units` has no `date_range` input, only `lookback_days`, which
resolves against today's date, so unlike `run_report`'s fixed window, its report definition changes every
calendar day — **every day this flag is used defines another new hidden, undeletable report** in the
network. Without the flag, the script prints one line on stderr saying the check was skipped and how to
run it, rather than skipping it silently.

`npm publish` is gated by `prepublishOnly` which runs build + tests + verify:pack — a publish can't ship a broken artifact.

See [CLAUDE.md](./CLAUDE.md) for design principles when extending the schema or tools (notably: this is a generic GAM MCP — no publisher-specific assumptions).
