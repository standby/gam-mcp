# gam-mcp

Read-only MCP server for **Google Ad Manager** analytics. Lets an LLM (Claude Desktop, Claude Code, any MCP client) answer real publisher questions — *what's revenue WoW, which line items are under-pacing, what's our fill rate by buyer network, where did sports ads land yesterday* — without writing report builders by hand.

12 tools cover descriptive ("what is happening"), comparative ("compared to what"), and diagnostic ("what's at risk") analytics. Generic across publishers — no per-network assumptions baked in.

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
           "GAM_NETWORK_CODE": "123456789",
           "GAM_SERVICE_ACCOUNT_KEY_FILE": "/Users/me/secrets/gam-sa.json",
           "GAM_TIMEZONE": "America/Los_Angeles"
         }
       }
     }
   }
   ```

   **Claude Code** — add the same `mcpServers` block to `.mcp.json` at your project root or to your global Claude Code config.

   **Alternative credential sources** — if mounting a key file isn't convenient (containers, hosted MCP), use one of:
   ```jsonc
   // inline JSON (raw or base64-encoded)
   "env": { "GAM_NETWORK_CODE": "123456789",
            "GAM_SERVICE_ACCOUNT_KEY_JSON": "eyJ0eXBlIjoic2VydmljZV9hY2NvdW50Ii4uLn0=" }
   ```
   ```jsonc
   // Application Default Credentials — no key vars needed
   // (works on GCE/Cloud Run, or locally after `gcloud auth application-default login`)
   "env": { "GAM_NETWORK_CODE": "123456789" }
   ```

3. Restart your MCP client.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GAM_NETWORK_CODE` | yes | — | Numeric network code |
| `GAM_SERVICE_ACCOUNT_KEY_FILE` | one-of | — | Absolute path to service-account JSON. Wins over `GAM_SERVICE_ACCOUNT_KEY_JSON` if both are set. |
| `GAM_SERVICE_ACCOUNT_KEY_JSON` | one-of | — | Service-account JSON inline, either as raw text or base64-encoded. Useful in hosted environments (Cloud Run, Fly, Render) where mounting a key file is awkward. Eagerly parsed at startup — a malformed value fails fast. |
| _(none of the above)_ | one-of | — | Falls back to **Application Default Credentials**. Picks up `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login` tokens, or the GCE/Cloud Run metadata server. |
| `GAM_TIMEZONE` | no | UTC | IANA timezone for relative-date resolution |
| `GAM_INLINE_ROW_THRESHOLD` | no | 200 | Rows ≤ this returned inline; above, spooled to a file (path returned in envelope) |
| `GAM_REPORT_TIMEOUT_MS` | no | 300000 | Max polling time per report job |
| `GAM_LOG_LEVEL` | no | `info` | One of `error`, `warn`, `info`, `debug`. Logs are JSON-lines on stderr — tool calls, GAM retries, report-job lifecycle, cache hits. Credentials are never logged. |
| `GAM_SAVED_QUERIES_FILE` | no | `${XDG_CONFIG_HOME:-$HOME/.config}/gam-mcp/saved-queries.json` | Path to the saved-query JSON store used by `save_query` / `run_saved_query`. Override when running multiple instances per machine or for testing. |
| `GAM_REPORT_CACHE_DIR` | no | _(off — in-memory only)_ | When set, report results (parsed rows) persist as gzipped JSON in this directory. Survives MCP restarts. No size cap — clear the directory manually if it grows large. |
| `GAM_REPORT_CACHE_TTL_MS` | no | 3600000 (1h) | Disk-cache TTL. Past TTL, entries are treated as misses and opportunistically deleted. Only meaningful when `GAM_REPORT_CACHE_DIR` is set. |
| `GAM_HTTP_PORT` | no | _(off — stdio mode)_ | When set, the MCP listens for Streamable-HTTP requests on this port at `POST /mcp` (with `GET /healthz` for probes), instead of stdio. Use for hosted/team deployments. |

## Tools

| Tool | Purpose |
|---|---|
| **Descriptive** | What's happening |
| `revenue_summary` | Total revenue/impressions, optionally grouped by day/week/month/advertiser/order/line_item/ad_unit/country/device/line_item_type |
| `top_advertisers`, `top_line_items` | Top-N by revenue or impressions, with context |
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
| `lookup` | Name ↔ ID resolution for advertisers, orders, line items, ad units, placements, companies, **custom_targeting_keys**. Lists up to 1000 with transparent pagination. |
| `describe_schema` | Browse the dimensions and metrics this MCP can query — **the complete GAM REST enum: 764 dimensions and 526 metrics.** Filter with `report_type` (what can legally appear in one request together), `family` (name prefix, e.g. `AD_EXCHANGE`), or `search` (substring of name or description). Unfiltered calls return names and types only; any filter turns on descriptions, report-type compatibility, and the curated `incompatible_with` hints |
| **Saved queries** | Templates the analyst can stash and replay |
| `save_query` | Persist a `run_report`-shaped template (dimensions + metrics + optional filters + custom_dimension_key_ids) under a name. Date range is deliberately not saved — supply it fresh at replay. |
| `list_saved_queries` | List every saved template with name, description, and save timestamp. |
| `run_saved_query` | Replay a saved template against a fresh `date_range`. Equivalent to `run_report` with the saved fields merged in. |
| `delete_saved_query` | Delete a saved template by name. |
| **Operations** | Diagnose the MCP itself |
| `health_check` | End-to-end probe — verifies auth + network + permissions by listing one company. Reports pass/fail with attributed cause (auth / permission / network / quota / wrong-network). Use after setup or when the LLM hits mysterious errors. |
| `usage_stats` | Session-to-date counters: GAM API calls by type, report-job count, cumulative report latency, cache hits/misses with hit-rate. Lets the LLM self-pace and the analyst spot redundant work. |

## Resources

The server also advertises an MCP `resources` capability so the LLM (or client UI) can browse the curated schema without spending a tool call:

| URI | Content |
|---|---|
| `gam://schema` | Full curated dimension + metric catalog with descriptions. |
| `gam://schema/dimensions` | Dimensions only. |
| `gam://schema/metrics` | Metrics only. |
| `gam://network` | Configured network code + timezone (only present when launched with `GAM_NETWORK_CODE`). |

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
6. **Specific ad units.** *"Revenue and impressions for our sports placements last week."* → `run_report` with `filters:[{field:"AD_UNIT_NAME", op:"CONTAINS", value:"sports"}]`.
7. **AdX yield diagnosis.** *"AdX match rate and average eCPM per ad unit yesterday."* → `run_report({dimensions:["AD_UNIT_NAME"], metrics:["AD_EXCHANGE_TOTAL_REQUESTS","AD_EXCHANGE_MATCH_RATE","AD_EXCHANGE_AVERAGE_ECPM"], date_range:{relative:"yesterday"}})`.
8. **Custom dimension breakdown.** *"Revenue by section."* → first `lookup({entity_type:"custom_targeting_key", query:"section"})` to find the key ID, then `run_report({dimensions:["CUSTOM_DIMENSION_0_VALUE"], metrics:["IMPRESSIONS","REVENUE"], date_range:{relative:"last_7_days"}, custom_dimension_key_ids:[<that_id>]})`.
9. **YoY comparison.** *"How does this month's revenue compare to the same month last year?"* → `compare_periods({base_range:{relative:"month_to_date"}, comparison:"previous_year", dimensions:["DATE"], metrics:["REVENUE"]})`.
10. **Top advertisers in a country.** *"Top advertisers in Hong Kong this month."* → `top_advertisers` with a `COUNTRY_NAME` filter.

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
- **In-process cache** — identical report queries within a session return cached rows instantly. No TTL (closed-period reports are immutable).

## Troubleshooting

- **"AUTH_FAILED"** — verify `GAM_SERVICE_ACCOUNT_KEY_FILE` path is readable and the service account has API access in the Ad Manager UI.
- **"REPORT_TIMEOUT"** — narrow the date range, or set `GAM_REPORT_TIMEOUT_MS=900000` for 15 minutes.
- **"REPORT_ERROR_CONSTRAINTS_INCOMPATIBILITY"** — some dimension/metric combos are forbidden by GAM (e.g., `AD_REQUESTS` × `LINE_ITEM_TYPE`). Split into separate queries.
- **"REPORT_ERROR_MISSING_DYNAMIC_DIMENSION_ID_AT_INDEX"** — you queried `CUSTOM_DIMENSION_<N>_VALUE` without supplying `custom_dimension_key_ids[N]`. Look the key ID up via `lookup(entity_type="custom_targeting_key")`.
- **"`gam-mcp: GAM_NETWORK_CODE is required`"** — the env var didn't make it into the subprocess. Check your MCP client config's `env` block.
- Logs go to **stderr**, not stdout. If your MCP client is hiding them, check its log file.

## Development

```bash
git clone <this repo>
cd gam-mcp
npm install
npm test                # unit tests with synthetic fixtures (~60 tests, ≈3s)
npm run build           # tsc → dist/
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run smoke
                        # opt-in: hits real GAM end-to-end
GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run verify:pack
                        # release gate: pack tarball, install in tempdir,
                        # exercise the bin as a real MCP client would
```

`npm publish` is gated by `prepublishOnly` which runs build + tests + verify:pack — a publish can't ship a broken artifact.

See [CLAUDE.md](./CLAUDE.md) for design principles when extending the schema or tools (notably: this is a generic GAM MCP — no publisher-specific assumptions).
