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

3. Restart your MCP client.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GAM_NETWORK_CODE` | yes | — | Numeric network code |
| `GAM_SERVICE_ACCOUNT_KEY_FILE` | yes | — | Absolute path to service-account JSON |
| `GAM_TIMEZONE` | no | UTC | IANA timezone for relative-date resolution |
| `GAM_INLINE_ROW_THRESHOLD` | no | 200 | Rows ≤ this returned inline; above, spooled to a file (path returned in envelope) |
| `GAM_REPORT_TIMEOUT_MS` | no | 300000 | Max polling time per report job |
| `GAM_LOG_LEVEL` | no | `info` | One of `error`, `warn`, `info`, `debug`. Logs are JSON-lines on stderr — tool calls, GAM retries, report-job lifecycle, cache hits. Credentials are never logged. |

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
| **Comparative** | Compared to what |
| `compare_periods` | Run any report twice and get per-row deltas — WoW, MoM, YoY, or explicit. Output rows carry `<metric>`, `<metric>_prev`, `<metric>_delta_pct`. |
| **Diagnostic** | What's at risk |
| `find_anomalies` | `pacing_underdelivery` flags line items below pro-rated MTD pace; `fill_rate_drops` flags ad units with WoW fill-rate drops over a threshold |
| **Power tools** | The escape hatches |
| `run_report` | Generic GAM Reports query — pick any dimensions/metrics from `describe_schema`, optional filters (`=`, `IN`, `!=`, `CONTAINS`, `NOT_CONTAINS`), optional `custom_dimension_key_ids` for KV reporting |
| `lookup` | Name ↔ ID resolution for advertisers, orders, line items, ad units, creatives, placements, companies, **custom_targeting_keys**. Lists up to 1000 with transparent pagination. |
| `describe_schema` | Browse the dimensions and metrics this MCP can query (≈40 entries spanning impressions/revenue/CTR, AdX/AdSense channel metrics, buyer-network/bidder dims, KV/custom-dimension targeting) |

## Example queries

Things an LLM with this MCP attached can answer directly. (No prompts engineering required — just ask.)

1. **WoW revenue check.** *"How does last week's revenue compare to the week before?"* → `compare_periods({dimensions:["DATE"], metrics:["REVENUE"], base_range:{relative:"last_7_days"}, comparison:"previous_period"})`.
2. **Programmatic vs direct mix.** *"What's the demand-channel breakdown for the last 30 days, with eCPM per channel?"* → `inventory_breakdown` plus a `run_report` slice on `LINE_ITEM_TYPE`.
3. **Buyer network share.** *"Which DSPs spend the most on us?"* → `run_report({dimensions:["BUYER_NETWORK_NAME"], metrics:["AD_EXCHANGE_REVENUE","AD_EXCHANGE_AVERAGE_ECPM"], date_range:{relative:"last_7_days"}})`.
4. **Pacing risk.** *"Which line items are under-pacing this month?"* → `find_anomalies({kind:"pacing_underdelivery", top_n:20})`.
5. **Fill-rate regression.** *"Did any ad units have a fill-rate drop this week?"* → `find_anomalies({kind:"fill_rate_drops", threshold_pct:5})`.
6. **Specific ad units.** *"Revenue and impressions for our sports placements last week."* → `run_report` with `filters:[{field:"AD_UNIT_NAME", op:"CONTAINS", value:"sports"}]`.
7. **AdX yield diagnosis.** *"AdX match rate and average eCPM per ad unit yesterday."* → `run_report({dimensions:["AD_UNIT_NAME"], metrics:["AD_EXCHANGE_TOTAL_REQUESTS","AD_EXCHANGE_MATCH_RATE","AD_EXCHANGE_AVERAGE_ECPM"], date_range:{relative:"yesterday"}})`.
8. **Custom dimension breakdown.** *"Revenue by section."* → first `lookup({entity_type:"custom_targeting_key", query:"section"})` to find the key ID, then `run_report({dimensions:["CUSTOM_DIMENSION_0_VALUE"], metrics:["IMPRESSIONS","REVENUE"], date_range:{relative:"last_7_days"}, custom_dimension_key_ids:[<that_id>]})`.
9. **YoY comparison.** *"How does this month's revenue compare to the same month last year?"* → `compare_periods({base_range:{relative:"month_to_date"}, comparison:"previous_year", dimensions:["DATE"], metrics:["REVENUE"]})`.
10. **Top advertisers in a country.** *"Top advertisers in Hong Kong this month."* → `top_advertisers` with a `COUNTRY_NAME` filter.

## Schema notes

- **`describe_schema`** returns the full curated catalog with descriptions tuned for LLM consumption. Read it before composing `run_report` queries.
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
