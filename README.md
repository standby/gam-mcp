# gam-mcp

Read-only MCP server for Google Ad Manager. Lets an LLM (e.g., Claude) analyze your network's revenue and inventory data through a small, opinionated tool surface plus a generic `run_report` escape hatch.

## Install

You don't. Add it to your MCP client config and let `npx` fetch it on first use.

## Setup

1. **Provision a service account** in Google Cloud Console with Ad Manager API access:
   - Create a project (or pick one).
   - Enable the Google Ad Manager API.
   - Create a service account, generate a JSON key, download it.
   - In Ad Manager (the UI): **Admin → Access & authorization → API access**, add the service account's email and grant it the read role you need (e.g., "Reports user" or higher).
2. **Add to your MCP client config** (Claude Desktop example):

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

3. Restart your MCP client.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `GAM_NETWORK_CODE` | yes | — | Numeric network code |
| `GAM_SERVICE_ACCOUNT_KEY_FILE` | yes | — | Absolute path to service-account JSON |
| `GAM_TIMEZONE` | no | UTC | IANA timezone for relative-date resolution |
| `GAM_INLINE_ROW_THRESHOLD` | no | 200 | Rows ≤ this returned inline; above, spooled to a file |
| `GAM_REPORT_TIMEOUT_MS` | no | 300000 | Max polling time for a report job |
| `GAM_LOG_LEVEL` | no | info | Reserved for future use; v1 always logs at info level to stderr |

## Tools

**Opinionated analytics:**
- `revenue_summary` — totals + grouping
- `top_advertisers`, `top_line_items`
- `pacing_status` — live-flighting line item pacing
- `fill_rate`, `inventory_breakdown`, `revenue_trend`

**Power tools:**
- `run_report` — generic Reports query
- `lookup` — name ↔ ID resolution
- `describe_schema` — list available dimensions/metrics

## Troubleshooting

- **"AUTH_FAILED"** — verify `GAM_SERVICE_ACCOUNT_KEY_FILE` path is readable, and that the service account has API access in your network.
- **"REPORT_TIMEOUT"** — narrow the date range, or set `GAM_REPORT_TIMEOUT_MS=900000` for 15 minutes.
- **"QUOTA_EXCEEDED"** — wait for the retry-after window; consider reducing concurrent tool calls.
- Logs go to **stderr**, not stdout. If your MCP client is hiding them, check its log file.

## Development

```bash
git clone <this repo>
cd gam-mcp
npm install
npm test          # unit + tool tests with fixtures
npm run smoke     # opt-in: hits real GAM with your credentials
npm run build     # tsc → dist/
```
