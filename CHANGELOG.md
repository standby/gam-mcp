# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/standby/gam_mcp/compare/v0.2.2...HEAD
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
