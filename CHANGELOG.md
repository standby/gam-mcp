# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-06-03

A large expansion of the report schema toward ad-performance, revenue, and
yield analysis, plus four new analysis tools. All additions are read-only and
verified `HISTORICAL`-compatible against the GAM REST report proto.

### Added
- **Creative size & blended eCPM** — `RENDERED_CREATIVE_SIZE` dimension (values
  like `300x250`), with `CREATIVE_SIZE` accepted as an alias that `run_report`
  transparently rewrites; `AVERAGE_ECPM` (total eCPM across ad server, AdSense,
  and Ad Exchange).
- **Video reporting** — completion-funnel metrics (`VIDEO_VIEWERSHIP_STARTS`,
  first/mid/third quartiles, completes, completion rate, view-through rate,
  average view time/rate) and `VIDEO_PLCMT_NAME` / `VIDEO_AD_DURATION`
  dimensions; new `video_breakdown` tool.
- **Viewability** — Active View denominators
  (`ACTIVE_VIEW_MEASURABLE_IMPRESSIONS`, `ACTIVE_VIEW_ELIGIBLE_IMPRESSIONS`,
  `ACTIVE_VIEW_MEASURABLE_IMPRESSIONS_RATE`); new `viewability_breakdown` tool.
- **Geo, dayparting, inventory & demand** — `REGION_NAME`, `METRO_NAME`,
  `HOUR`, `DAY_OF_WEEK`, `PLACEMENT_ID`/`PLACEMENT_NAME`,
  `INVENTORY_FORMAT_NAME`, `DEMAND_CHANNEL_NAME`.
- **Programmatic deals** — `DEAL_NAME`, `DEAL_ID`, `DEAL_BUYER_NAME`,
  `DEAL_BUYER_ID`, `EXCHANGE_BIDDING_DEAL_TYPE_NAME` dimensions and the deal bid
  funnel (`DEALS_BID_REQUESTS`, `DEALS_BIDS`, `DEALS_BID_RATE`,
  `DEALS_WINNING_BIDS`, `DEALS_WIN_RATE`).
- **Yield groups / Open Bidding** — `YIELD_GROUP_NAME`/`ID`/`BUYER_NAME`/
  `BUYER_TAG_NAME` dimensions, the mediation + auction funnel metrics, and the
  combined `AD_EXCHANGE_PLUS_YIELD_GROUP_*` view; new `yield_breakdown` tool.
- **`diagnose_floor_pricing`** — infers AdX floor-price effectiveness per ad
  unit from the match-rate × eCPM relationship vs the network median, with an
  upper-bound `est_opportunity`. Inferential (GAM REST exposes no floor value),
  not a UPR readout.

### Changed
- Extracted shared report-run helpers (`runAndRead`, `lookbackRange`,
  `previousPeriod`, `numOr0`, `pct`) into `src/report-run.ts`; `run_report`'s
  curated incompatibility matrix extended for the new programmatic-demand
  dimensions.

## [0.3.1] — 2026-05-18

### Added
- `lookup` returns both `name` and `displayName` for every entity. For
  `custom_targeting_key`, `name` is the API code that appears in
  `KEY_VALUES_NAME` report rows (sourced from GAM's `adTagName`) and
  `displayName` is the human-readable label — so a `channel_id` value from
  a KV report row resolves directly to its key ID without a second lookup.
- `lookup` accepts `match: "substring" | "exact"`. Exact mode emits the
  AIP-160 equality filter — `name = "channel_id"` for
  `custom_targeting_key`, `displayName = "..."` elsewhere — and there is
  an auto-fallback from substring to exact when GAM rejects the
  substring filter for a custom-targeting-key query.
- `describe_schema` surfaces a curated `incompatible_with` column listing
  dimensions/metrics GAM refuses to combine with each entry (e.g.,
  `KEY_VALUES_NAME` ⊥ `AD_REQUESTS`, `AD_EXCHANGE_MATCH_RATE` ⊥ the
  line-item/advertiser/order dimensions). Symmetric — both sides of each
  pair carry the hint. Best-effort; an empty list does not guarantee
  GAM will accept the combination.
- `run_report` auto-rewrites a `KEY_VALUES_NAME='<key>=<value>'` filter to
  a `CUSTOM_DIMENSION_<N>_VALUE` filter (resolving the key via
  `lookup(match="exact")` and allocating the next free
  `custom_dimension_key_ids` slot) when the requested metrics are
  incompatible with `KEY_VALUES_NAME`. The rewrite is surfaced in the
  envelope's `warnings[]` so callers can see exactly what happened.
- `kv_report` tool — high-level wrapper that accepts `kv: "key=value"`,
  optional `ad_unit_id` / `ad_unit_name` / `order_id` / `line_item_id`,
  a date range, and metrics. Resolves the key, picks a CUSTOM_DIMENSION
  slot, and runs a report compatible with any request-time or
  programmatic metric — folding what was previously a multi-step
  `lookup` → `run_report` dance into a single call.

## [0.3.0] — 2026-05-18

### Added
- `health_check` tool — single-call probe that verifies auth + network +
  permissions by calling `listEntities` for one company. Reports pass/fail
  with attributed cause (auth, permission, network, quota, wrong-network).
- `usage_stats` tool — session-to-date counters for GAM API calls,
  report-job count, cumulative report latency, and report-cache hit rate.
  Backed by a thin instrumentation wrap around `GAMClient` plus
  `ReportCache.stats()`.
- Disk-backed report cache — when `GAM_REPORT_CACHE_DIR` is set, parsed
  report rows persist as gzipped JSON keyed by a sha256 of the canonical
  query. Survives MCP restarts. Two-tier read (memory → disk → miss);
  disk hits warm the memory tier. TTL configurable via
  `GAM_REPORT_CACHE_TTL_MS` (default 1h). Off by default.
- HTTP/Streamable transport — when `GAM_HTTP_PORT` is set, the MCP serves
  Streamable-HTTP requests at `POST /mcp` (with `GET /healthz` for probes)
  instead of stdio. Stateless mode; suits hosted/team deployments. Default
  remains stdio.
- Release automation — `release-please-action` maintains a release PR that
  bumps versions, promotes the CHANGELOG `[Unreleased]` block, and tags
  `vX.Y.Z` on merge (which triggers the existing `publish.yml`). Conventional
  Commits → Keep-A-Changelog sections.
- Auth alternatives — `GAM_SERVICE_ACCOUNT_KEY_FILE` is no longer the only way
  to authenticate. New `GAM_SERVICE_ACCOUNT_KEY_JSON` accepts service-account
  JSON inline (raw or base64-encoded). With neither set, the server falls
  back to Application Default Credentials (GCE/Cloud Run metadata,
  `gcloud auth application-default`, or `GOOGLE_APPLICATION_CREDENTIALS`).
  Precedence is `KEY_FILE` → `KEY_JSON` → ADC, so existing setups with
  `GAM_SERVICE_ACCOUNT_KEY_FILE` set keep using that exact code path with no
  behavior change.
- `diagnose_fill_rate` tool — attributes a single root cause per ad unit for
  low fill (`healthy`, `tag_integration`, `demand_collapse`, `low_match_rate`,
  `direct_underdelivery`, `no_demand`, `mixed`) by walking the AdX funnel
  (requests → routed to AdX → AdX match → ad-server response → unfilled) and
  comparing against the previous period. Ranks results by
  unfilled-impression volume so high-impact gaps surface first. Each row
  carries the supporting ratios so attributions are auditable.
- `find_unused_ad_units` tool — flags "codeless" ad units (those receiving
  fewer than `min_requests` ad requests over a lookback window) by
  set-differencing `listEntities` against a Reports run. Defaults
  `lookback_days=30`, `min_requests=0`.
- Saved-query persistence — four tools (`save_query`, `list_saved_queries`,
  `run_saved_query`, `delete_saved_query`) backed by a JSON file at
  `${XDG_CONFIG_HOME:-$HOME/.config}/gam-mcp/saved-queries.json` (overrideable
  via `GAM_SAVED_QUERIES_FILE`). Date range is intentionally not part of the
  saved template — replay always supplies a fresh window.
- MCP `resources` capability — `gam://schema`, `gam://schema/dimensions`,
  `gam://schema/metrics`, and `gam://network` are now advertised as readable
  resources so clients can browse the schema without burning a tool call.
- MCP `prompts` capability — three preset workflows: `weekly_pacing_review`,
  `monthly_revenue_close`, `fill_rate_postmortem`.

## [0.2.3] — 2026-05-18

### Added
- `bidder_breakdown` tool — Open Bidding (EBDA) yield by `BIDDER_NAME` using
  AdX-only impression/revenue/eCPM metrics, with optional secondary slice by
  day, ad unit, country, device, or line item type.
- `find_anomalies` kind `ecpm_regression` — buyer networks (DSPs / AdX /
  AdSense) whose AdX average eCPM dropped week-over-week by more than
  `threshold_pct` percent of prior eCPM (default 15%). Low-volume buyers
  (<10k AdX impressions either side) are filtered.
- `find_anomalies` kind `viewability_drops` — ad units whose Active View
  viewable-impression rate dropped week-over-week by more than `threshold_pct`
  percentage points (default 5pp). Low-volume ad units (<10k imps either
  side) are filtered.

## [0.2.2] — 2026-05-17

### Added
- `kv_breakdown` tool — value-level breakdowns for custom-targeting keys.
- Structured stderr logger gated by `GAM_LOG_LEVEL` (stdout reserved for the MCP
  protocol channel).
- `TAXONOMY_CATEGORY` dimensions exposed for PPS / content-taxonomy reports.
- `CHANGELOG.md` covering all releases from `0.1.0` forward.

### Fixed
- `listEntities` filter now uses the `displayName` has-operator instead of
  emitting `CONTAINS` (which GAM REST rejects).

### Changed
- `package-lock.json` version field synced with `package.json`.

## [0.2.1] — 2026-05-04

First version intended as a stable starting point for new installs. Content is
identical to 0.2.0 — the bump is a deprecation signal so `0.1.x` and `0.2.0`
can be retired on npm in favor of `>= 0.2.1`. Verified end-to-end via
`verify:pack` against a production network.

## [0.2.0] — 2026-05-04

The first version where the tool surface is intentional rather than evolved.
Cumulative work since 0.1.8 turned this from a GAM data accessor into a
decision-making toolkit.

### Added
- `find_anomalies` diagnostic tool with two modes:
  - `pacing_underdelivery` — line items below pro-rated MTD pace, sorted by
    impression shortfall.
  - `fill_rate_drops` — ad units with WoW fill-rate drops above a threshold,
    sorted by drop in percentage points.
- README rewrite: tool table organized by descriptive / comparative /
  diagnostic / power-tools axes; 10 example queries; schema-quirks section
  (KV slot overlap, no-EQUALS filter, dimension/metric incompatibilities);
  reliability and troubleshooting sections.

### Fixed
- Replaced the non-existent `LINE_ITEM_GOAL_QUANTITY` dimension with the real
  REST dimensions `LINE_ITEM_PRIMARY_GOAL_UNITS_ABSOLUTE`,
  `_PERCENTAGE`, and `LINE_ITEM_PRIMARY_GOAL_TYPE_NAME`. The old name had
  shipped in the schema since pre-0.1.0 and would return HTTP 400 the first
  time anything queried it.

### Out of scope
- `forecast_inventory` is structurally out of scope until GAM's v1 REST API
  exposes forecasting endpoints — currently only the legacy SOAP API does, and
  this MCP commits to one API per `CLAUDE.md`.

## [0.1.12] — 2026-05-04

Reliability pass — three improvements that compound across a session.

### Added
- `withRetries` fetch wrapper: exponential backoff with 0–25% jitter on
  `429`/`5xx` and network errors; 4 attempts total at a 250 ms base delay;
  non-`429` `4xx` responses surface immediately (those are caller bugs, not
  transient infrastructure). Wired through `cli.ts` so a single quota blip or
  502 no longer tears down a multi-step LLM session.
- Transparent pagination on `listEntities`: optional `limit` up to 1000 in the
  lookup tool (200 default). Internally pages through GAM's 200-row responses
  via `nextPageToken` and returns a flat array.
- In-process report cache (`src/cache.ts`) keyed by a canonicalized
  `{dimensions, metrics, filters, date_range, custom_dimension_key_ids}`
  tuple. `run_report` and `compare_periods` consult the cache before issuing
  `createReport`, saving ~25–30 s per cache hit. No TTL or eviction by design:
  stdio MCP processes are short-lived, closed-period reports are immutable,
  and sessions are bounded.

## [0.1.11] — 2026-05-04

### Added
- AdX / AdSense channel metrics.
- `CONTAINS` filter operator on `run_report`.

## [0.1.10] — 2026-05-04

### Added
- `compare_periods` tool — WoW / MoM / YoY comparisons against every existing
  reporting tool.

## [0.1.9] — 2026-05-04

### Added
- KV / `CUSTOM_DIMENSION_<N>_VALUE` reporting plus a `custom_targeting_key`
  lookup so callers can resolve publisher-configured slots dynamically.

### Changed
- Documented the generic-MCP principle in `CLAUDE.md`: never bake
  publisher-specific assumptions (slot meanings, KV keys, advertiser names)
  into the codebase. Slot→key mappings arrive per-query; discovery happens via
  GAM REST.

## [0.1.8] — 2026-05-04

### Added
- Buyer-network / bidder dimensions.
- Ad-server eCPM and ad-server responses metrics.

## [0.1.7] — 2026-05-04

### Added
- `verify:pack` release-gate script.

### Fixed
- `run_report` filter wire shape corrected to match GAM REST so filtered
  reports actually take filters into account.

## [0.1.6] — 2026-05-04

### Fixed
- `lookup` now works for ad units and any other entity without an explicit
  `id` field.

## [0.1.5] — 2026-05-03

### Fixed
- Unblocked MCP stdio transport and corrected tool schemas so a fresh
  `npx`-installed instance comes up cleanly under a stdio MCP client.

## [0.1.4] — 2026-05-03

### Fixed
- Metric names migrated from SOAP Ad Manager naming
  (`TOTAL_LINE_ITEM_LEVEL_IMPRESSIONS`, etc.) to the REST API v1 names defined
  in `google/ads/admanager/v1/report_definition.proto`. Affected:
  `src/schema.ts`, `revenue_summary`, `revenue_trend`, `top_line_items`,
  `top_advertisers`, `fill_rate`.
- Version field correction.

## [0.1.3] — 2026-05-01

### Changed
- Lowered `engines.node` floor to Node 22 (still in LTS) for broader runtime
  compatibility.

## [0.1.2] — 2026-05-01

### Added
- MIT `LICENSE`.

## [0.1.1] — 2026-05-01

### Added
- `repository`, `bugs`, and `homepage` fields in `package.json`.

## [0.1.0] — 2026-05-01

Initial public release on npm.

### Added
- Stdio MCP server exposing Google Ad Manager as a tool surface, runnable via
  `npx` with zero clone / build steps.
- Tag-triggered npm publish workflow with provenance.
- Initial README documenting setup, auth, and tool surface.

### Changed
- CI and `engines` bumped to Node 24; `checkout` and `setup-node` actions
  updated to v5.

[Unreleased]: https://github.com/standby/gam_mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/standby/gam_mcp/compare/v0.3.1...v0.4.0
[0.2.2]: https://github.com/standby/gam_mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/standby/gam_mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/standby/gam_mcp/compare/v0.1.12...v0.2.0
[0.1.12]: https://github.com/standby/gam_mcp/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/standby/gam_mcp/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/standby/gam_mcp/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/standby/gam_mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/standby/gam_mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/standby/gam_mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/standby/gam_mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/standby/gam_mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/standby/gam_mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/standby/gam_mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/standby/gam_mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/standby/gam_mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/standby/gam_mcp/releases/tag/v0.1.0
