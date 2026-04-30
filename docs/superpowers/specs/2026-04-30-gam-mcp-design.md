# Google Ad Manager MCP — Design Spec

**Date:** 2026-04-30
**Status:** Approved for planning
**Scope:** v1 (read-only analytics MCP for a single publisher / single GAM network)

## Goal

Ship a Node.js MCP server, installable via `npx gam-mcp`, that lets an LLM analyze a publisher's Google Ad Manager (GAM) network — primarily revenue performance and inventory/yield. The MCP exposes GAM as a small set of opinionated analytical tools plus a generic query escape hatch, returning data inline for small results and spooling large results to temp files for the LLM to analyze with file tools.

## Scope

**In scope (v1):**
- Revenue performance: line item / order delivery, revenue by advertiser/order/line item, eCPM, pacing.
- Inventory & yield: fill rate, sell-through by ad unit, programmatic vs. direct mix, line-item-type breakdown.
- Read-only access to entities (orders, line items, ad units, advertisers, creatives) to support lookups and contextual joins.

**Out of scope (deferred to later versions):**
- Forecasting (availability) — separate API surface, defer.
- Audience segments and creative-level performance dashboards — generic `run_report` will support creative dimensions, but no opinionated tools.
- Any write operations.
- Multi-network support, runtime network switching.
- OAuth interactive auth flows; service account is the only auth path.
- Persistence beyond a per-session temp directory.

## Constraints

- **Distribution:** runnable via `npx gam-mcp` with no clone, no compile, no `postinstall` build step. The npm-published `dist/` is what runs.
- **Transport:** stdio MCP server. Stdout reserved for the protocol; all logs to stderr in JSON-lines.
- **Auth:** Google service account JSON, path supplied via `GAM_SERVICE_ACCOUNT_KEY_FILE`. Never bundled, logged, or echoed in tool output.
- **Single network:** `GAM_NETWORK_CODE` set at startup; tools do not accept a network argument.
- **GAM API surface:** the modern Ad Manager REST API (not the legacy SOAP API, not BigQuery Data Transfer). Pinned API version per release.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  MCP client (Claude, etc.)                                   │
└──────────┬───────────────────────────────────────────────────┘
           │ stdio (JSON-RPC, MCP protocol)
┌──────────▼───────────────────────────────────────────────────┐
│  gam-mcp (Node.js)                                           │
│                                                              │
│  ┌─ MCP server ──────────────────────────────────────────┐   │
│  │  Transport, tool registry, schema validation, errors. │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ Tools layer ─────────────────────────────────────────┐   │
│  │  Opinionated tools + run_report + lookup +            │   │
│  │  describe_schema. One module per tool.                │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ GAM client ──────────────────────────────────────────┐   │
│  │  REST wrapper: report job lifecycle, entity reads,    │   │
│  │  metadata. Mockable for tests.                        │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ Output layer ────────────────────────────────────────┐   │
│  │  Adaptive inline/file decision, schema header parsing,│   │
│  │  preview rows, temp dir lifecycle.                    │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ Auth ────────────────────────────────────────────────┐   │
│  │  google-auth-library, service-account JSON,           │   │
│  │  in-memory token cache.                               │   │
│  └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                  Google Ad Manager REST API
```

Each layer is independently testable. The GAM client is the only dependency tools have on Google's API; mocking it covers the bulk of tool tests.

## Configuration (env vars)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `GAM_NETWORK_CODE` | yes | — | The numeric network code, e.g., `123456789`. |
| `GAM_SERVICE_ACCOUNT_KEY_FILE` | yes | — | Absolute path to service-account JSON key. |
| `GAM_TIMEZONE` | no | network's reporting timezone | IANA TZ string used for relative-date resolution. |
| `GAM_INLINE_ROW_THRESHOLD` | no | `200` | Rows ≤ this returned inline; above, spooled to a file. |
| `GAM_REPORT_TIMEOUT_MS` | no | `300000` (5 min) | Maximum time to poll a report job before giving up. |
| `GAM_LOG_LEVEL` | no | `info` | One of `error`, `warn`, `info`, `debug`. |

No persistent config file. Env vars only.

## Tool catalog

### Opinionated analytical tools

| Tool | Question it answers | Key args |
|---|---|---|
| `revenue_summary` | Revenue/impressions/eCPM for a date range, optionally grouped by `day`, `week`, `month`, `advertiser`, `order`, `line_item`, `ad_unit`, `country`, `device_category`, or `line_item_type`. | `date_range`, `group_by?`, `top_n?`, `filters?` |
| `top_advertisers` | Top N advertisers by revenue or impressions. | `date_range`, `top_n=20`, `metric` |
| `top_line_items` | Top N line items by revenue/impressions, with order + advertiser context. | `date_range`, `top_n=20`, `metric`, `line_item_type?` |
| `pacing_status` | Current vs. expected delivery for currently-flighting line items (under/on/over). | `line_item_ids?`, `order_ids?` |
| `fill_rate` | Fill rate, unfilled impressions, sell-through, grouped by `ad_unit`, `device_category`, `country`, or `day`. | `date_range`, `group_by`, `top_n?` |
| `inventory_breakdown` | Programmatic vs. direct vs. house mix; revenue/impressions by `line_item_type`. | `date_range`, `group_by?` |
| `revenue_trend` | Time series at daily or weekly granularity, optionally split by one dimension. | `date_range`, `granularity`, `split_by?` |

### Power tools

| Tool | What it does |
|---|---|
| `run_report` | Generic Reports API access: take any combination of dimensions, metrics, filters (PQL `WHERE`-like), and date range. Includes creative dimensions and click/CTR/viewability/video metrics, even though no opinionated tool exposes them. |
| `lookup` | Resolve names ↔ IDs for `advertiser`, `order`, `line_item`, `ad_unit`, `creative`, `placement`, `company`. Substring or exact match. |
| `describe_schema` | Returns the available dimensions, metrics, dimension attributes, valid combinations, and human-readable descriptions. Served from a static catalog shipped in the package, regenerated from the GAM metadata endpoint at publish time. |

### Standard return shape

```jsonc
{
  "summary": "Top 10 advertisers by revenue, 2026-04-01 to 2026-04-29",
  "row_count": 10,
  "schema": [{ "name": "advertiser_name", "type": "string" }, ...],
  "rows": [...],          // present iff row_count <= GAM_INLINE_ROW_THRESHOLD
  "file_path": "...",     // present otherwise; rows omitted
  "preview_rows": [...],  // present when file_path is set: first 50 rows
  "warnings": [...]       // e.g., "results truncated by API at 1M rows"
}
```

Uniform across opinionated tools, `run_report`, and `lookup`. The LLM learns one shape.

### Auto-resolve names in filter args

Every tool that accepts entity filters takes either a numeric ID or a name string:
- Numeric → used as ID directly.
- Non-numeric → triggers an internal `lookup` before the report fires.
- 0 matches → `ENTITY_NOT_FOUND` error with hint to call `lookup` directly.
- Multiple matches → `AMBIGUOUS_NAME` error with top candidates so the LLM can pick.

### Relative-date enum

Tools accepting `date_range` accept either `{ start: "YYYY-MM-DD", end: "YYYY-MM-DD" }` or `{ relative: <enum> }` where the enum is:

`today | yesterday | last_7_days | last_30_days | last_week | last_full_month | month_to_date | quarter_to_date | last_quarter | year_to_date`

Resolved server-side using the network timezone, never the LLM's notion of "today."

## Data flows

### Server startup

1. Load env, validate `GAM_NETWORK_CODE` and `GAM_SERVICE_ACCOUNT_KEY_FILE` are set and the key file is readable JSON.
2. Construct (lazy) `GoogleAuth` — no token fetched yet.
3. Register tools.
4. Create temp dir `os.tmpdir()/gam-mcp/<pid>-<rand>/`.
5. Install SIGINT/SIGTERM handlers → cleanup temp dir.
6. Open the stdio MCP transport. No GAM call at startup.

### Synchronous tool path (`lookup`, `describe_schema`)

Validate input → ensure auth token (cached) → single REST call → map to canonical row shape → return inline. `describe_schema` is served from the shipped JSON, no live API call.

### Report tool path (everything else)

1. Validate input, resolve relative dates against network timezone, auto-resolve any name filters.
2. Translate to a `ReportQuery` (dimensions, columns, dateRange, statement).
3. `POST /networks/{n}/reports` → returns operation handle.
4. Poll the operation: every 2s, exponential backoff to a 15s ceiling. Default timeout 5 min (configurable via `GAM_REPORT_TIMEOUT_MS`).
5. On `done`, stream the gzipped CSV from the download URL into a temp file.
6. Count rows from the streamed file; parse schema from the CSV header.
7. **Output decision:**
   - `row_count ≤ GAM_INLINE_ROW_THRESHOLD` → parse rows, return inline, delete file.
   - Otherwise → keep file, return `{ file_path, schema, row_count, preview_rows }` (first 50 rows).
8. Return the standard envelope.

**Always-write-to-disk-first** keeps streaming logic simple and consistent. Small results pay one extra fs write/delete per call — trivial on modern systems.

### Token / quota handling

- Token cached in-memory by `google-auth-library`; refreshed automatically before expiry.
- 429 / `RESOURCE_EXHAUSTED` → structured `QUOTA_EXCEEDED` error with retry-after; no auto-retry.
- 5xx → one retry with 2s backoff, then surface the error.
- Report-job failures (deterministic — bad query etc.) → no retry, surface directly.

## Error handling

Every error returns a structured envelope:

```jsonc
{
  "error": {
    "code": "INVALID_DATE_RANGE" | "AUTH_FAILED" | "QUOTA_EXCEEDED"
          | "REPORT_FAILED" | "REPORT_TIMEOUT" | "ENTITY_NOT_FOUND"
          | "AMBIGUOUS_NAME" | "UNSUPPORTED_DIMENSION_COMBO"
          | "INTERNAL_ERROR",
    "message": "Human-readable, one sentence.",
    "hint": "Concrete next step the LLM can take.",
    "details": { /* code-specific structured fields */ }
  }
}
```

`hint` is rendered from a static catalog keyed by `code`, not by interpreting GAM's error strings.

### Validation (zod, fail-fast)

- Dates: ISO 8601, end date no later than "yesterday in network timezone."
- Top N: clamped to `[1, 1000]`.
- Dimension/metric names in `run_report`: validated against the shipped schema; misspellings get "did you mean X" hints.
- IDs vs. names: numeric strings are treated as IDs; everything else triggers auto-lookup.

### Logging

- Stderr only, JSON-lines, level controlled by `GAM_LOG_LEVEL`.
- Tokens truncated to last 8 characters in logs. Report rows never logged.
- Per-tool-call correlation ID at start and end.

### Stdout guard

Anything the process writes to stdout outside the MCP transport is intercepted and redirected to stderr with a warning. Cheap insurance against a stray `console.log` in a dependency corrupting the protocol.

## Testing

### Layer 1: Unit tests (no network)

- Input validation per tool (date arithmetic, relative-date resolution against fixed `now` + timezone, top-N clamping, dimension whitelist).
- Output layer: inline-vs-file decision at threshold boundary, schema parsing, preview extraction, temp-file cleanup.
- Error catalog: every code resolves to a hint; hint templates render with substitutions.
- Stdout guard: writes to `process.stdout` get redirected to stderr.

### Layer 2: Tool tests with a mocked GAM client

- `GAMClient` interface mocked; fixtures committed under `tests/fixtures/`:
  - Recorded report CSVs (gzipped, scrubbed of real network/advertiser names).
  - Operation polling sequences (pending → running → done; plus failed and timeout variants).
  - Entity list fixtures for `lookup`.
- Each tool test asserts both the **outbound query the tool generated** and the **return envelope**.

### Layer 3: Live smoke test (manual, opt-in)

`npm run smoke` against a real network using developer credentials. Runs before publish. Not in CI.

### Tooling

- Test runner: `vitest`.
- Mocking: plain DI; pass a mock `GAMClient`. No module-level magic.
- Coverage: aim >80% on `tools/` and `output/`, no CI enforcement.

## Package layout

```
gam-mcp/
├── package.json              # "bin": {"gam-mcp": "./dist/cli.js"}, "type": "module"
├── README.md                 # install, env vars, MCP client config, troubleshooting
├── src/
│   ├── cli.ts                # entrypoint
│   ├── server.ts             # MCP server, tool registry, stdout guard
│   ├── auth.ts
│   ├── gam-client.ts         # GAM REST client
│   ├── output.ts             # inline-vs-file, temp dir, preview
│   ├── errors.ts             # error catalog + hint templates
│   ├── dates.ts              # relative-date resolver
│   ├── schema.ts             # static dimension/metric catalog (generated)
│   └── tools/
│       ├── index.ts
│       ├── revenue_summary.ts
│       ├── top_advertisers.ts
│       ├── top_line_items.ts
│       ├── pacing_status.ts
│       ├── fill_rate.ts
│       ├── inventory_breakdown.ts
│       ├── revenue_trend.ts
│       ├── run_report.ts
│       ├── lookup.ts
│       └── describe_schema.ts
├── scripts/
│   └── refresh-schema.ts     # regenerates src/schema.ts from GAM metadata
├── tests/
│   ├── fixtures/
│   └── *.test.ts
└── dist/                     # tsc output, what npm publishes
```

`tsc` runs in `prepublishOnly`, never on user install. Users `npx` the compiled JS.

## MCP client integration (the install story)

1. User provisions a Google Cloud service account with Ad Manager API access; downloads the JSON key. (One-time, manual; documented in README.)
2. Adds to their MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "google-ad-manager": {
         "command": "npx",
         "args": ["-y", "gam-mcp"],
         "env": {
           "GAM_NETWORK_CODE": "123456789",
           "GAM_SERVICE_ACCOUNT_KEY_FILE": "/Users/me/secrets/gam-sa.json"
         }
       }
     }
   }
   ```

First run downloads + caches the package; subsequent runs are instant.

## Versioning

- Semver. Tool input/output shapes are part of the public surface; renames or removed fields → major bump.
- `src/schema.ts` regenerated by `scripts/refresh-schema.ts` before each publish. Stale catalog is a published-version issue, not a runtime issue — `npx` always fetches the latest.

## Risks

| Risk | Mitigation |
|---|---|
| GAM REST API drift (deprecated fields, schema changes) | Schema-refresh script + smoke test before each publish; pinned API version per release. |
| Quota exhaustion (Ad Manager API quotas are per-network and tighter than they appear) | No auto-retries on report jobs; structured `QUOTA_EXCEEDED` errors with retry-after; documented quota expectations. |
| Report timeout for large networks (e.g., 90-day network-wide queries) | Documented `GAM_REPORT_TIMEOUT_MS`; timeout error hint suggests narrowing the date range. |
| Service-account JSON leaking via logs or tool responses | Token truncation in logs; explicit policy that errors never echo credentials; stdout guard. |
