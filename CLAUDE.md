# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project intent

This repo is a Node.js **MCP (Model Context Protocol) server** that exposes **Google Ad Manager (GAM)** as tools an LLM can call to collect analytics data for analysis. It is not a general GAM admin tool — the surface area should be biased toward read/report operations (running reports, fetching reports, listing/inspecting networks, orders, line items, creatives, inventory) rather than write/mutation operations.

## Hard constraints

- **Distribution:** must be runnable via `npx <package>` with zero clone/build steps. The `package.json` `bin` entry is the entrypoint; the `main`/`bin` script must be the MCP stdio server. Don't introduce a build step that breaks `npx` (no required `postinstall` compile, no missing `files` field).
- **Transport:** stdio MCP server by default. Logs go to stderr, never stdout — stdout is the MCP protocol channel and any stray write corrupts the session.
- **Auth:** GAM uses OAuth2 / service-account credentials. Credentials come from the user's environment (env vars or a path to a JSON key file passed in config) — never bundled, never logged, never echoed in tool responses.
- **GAM API:** Google Ad Manager exposes both a legacy SOAP Ad Manager API and the newer Ad Manager API (REST/gRPC). Pick one and document the choice in README; don't half-implement both. Reports in GAM are asynchronous (create job → poll → download) — tools that wrap reports must handle the polling shape, not pretend it's synchronous.

## Generic-MCP principle

This is a generic GAM MCP — it must work for any publisher's network out of the box. **Never bake publisher-specific data into the codebase**: no hardcoded network codes, no example values in descriptions that look like assumptions ("slot 0 = section"), no fixtures derived from one network's actual KV keys, custom dimension names, advertiser names, or line item naming conventions.

Concrete rules:
- **Slot-based dimensions** (`CUSTOM_DIMENSION_<N>_VALUE`, `LINE_ITEM_CUSTOM_FIELD_<N>_*`, etc.) — the slot→key mapping is per-network and per-query. Descriptions should say "publisher-configured slot N" and never imply a meaning. The mapping arrives via a query parameter (e.g., `custom_dimension_key_ids`), not a config file.
- **Discovery over assumption** — when a query needs publisher-specific IDs (custom targeting keys, custom field IDs, etc.), expose a list/lookup tool that hits the corresponding GAM REST endpoint. Don't ask the user to configure anything statically.
- **Tool descriptions** — speak about GAM concepts in the abstract. "Open Bidding bidder display name" is fine; "e.g. PubMatic" is not, because it implies the user has PubMatic configured.

## Design guidelines for tools

- Tool names should read as verbs the LLM would pick from a list: `run_report`, `get_report_results`, `list_orders`, not `gamReportServiceCreateReportJob`.
- Each tool's input schema must have descriptions on every field — the schema is the LLM's only documentation.
- Return structured JSON, not pre-formatted text. The LLM consuming this MCP will format for the user.
- Paginate large results. GAM report rows can be enormous — stream/page rather than buffering whole CSVs into a tool response.

## Commit messages

- Do not add `Co-Authored-By: Claude` (or any other Claude/AI attribution) to commit messages. The author/committer fields are sufficient.
- Do not add `🤖 Generated with Claude Code` footers or similar tool-credit lines.
- Follow the repo's existing Conventional Commits style (`fix:`, `chore:`, `ci:`, `docs:`).

## Commands

- `npm install` — install dependencies. No build step is required to run the tests.
- `npm test` / `npm run test:watch` — unit tests (vitest) against synthetic fixtures; no GAM credential needed.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run build` — `tsc` → `dist/`. This is what `npx gam-mcp` runs, via the `bin` entry (`dist/cli.js`).
- `GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run smoke` — opt-in: hits a real GAM network through the library (not the packaged binary).
- `GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run smoke:transports -- --yes` — opt-in: drives the packaged `dist/cli.js` over both stdio and HTTP, then repeats the run in a fresh process to prove report reuse survives a restart. Add `--define-ad-unit-report` to also exercise `find_unused_ad_units` — separately opt-in, since (see the report path below) it defines a new hidden GAM report every calendar day it runs.
- `GAM_NETWORK_CODE=... GAM_SERVICE_ACCOUNT_KEY_FILE=... npm run verify:pack` — release gate: packs the tarball, installs it in a tempdir, and exercises the `bin` as a real MCP client would. Also runs automatically via `prepublishOnly`, so `npm publish` can't ship a broken artifact.
- `npm run refresh-schema` / `npm run schema:gap` — regenerate, or diff, `src/schema-generated.ts` against GAM's live REST discovery document.

## Architecture

- **GAM API flavor: the newer Ad Manager REST API**, not the legacy SOAP API — `src/gam-client-rest.ts` calls `https://admanager.googleapis.com/v1`. The only OAuth scope requested is `https://www.googleapis.com/auth/admanager` (`src/auth.ts`); this API has no narrower read-only scope, so read-only behavior is enforced by which endpoints the client ever calls, not by the credential.
- **Transport layer**: `src/cli.ts` is the entrypoint. Stdio is the default (`connectStdio` in `src/server.ts` connects one long-lived `Server`). Setting `GAM_HTTP_PORT` switches to HTTP instead (`src/http-transport.ts`, the SDK's Streamable HTTP transport in stateless mode) — because it's stateless, a **new** `Server` and transport are built per request; a transport hoisted out of the request handler goes dead after its first response. HTTP additionally checks a Host allowlist, an optional bearer token, and a 1 MiB request body limit before a request reaches the SDK, and does not register the saved-query tools (they read/write a local file, which doesn't make sense to share across a hosted deployment's callers).
- **Auth flow**: `src/auth.ts` resolves one of three credential sources — an explicit service-account key file, inline JSON (raw or base64), or Application Default Credentials — and wraps `google-auth-library`'s `GoogleAuth` to mint bearer tokens. `withRetries()` in `src/gam-client-rest.ts` wraps `fetch` with exponential backoff (4 attempts, 250ms base + jitter): a GET retries on a thrown fetch, 429, or 5xx; a POST retries only on 429, the one case where GAM provably didn't act on the request. `checkNetworkIdentity()` (`src/startup.ts`) reads the configured network with the given credential before the server starts serving any tool, so a bad credential or wrong network code fails at startup, not on the first tool call.
- **Tool registry pattern**: every tool is a `ToolDefinition` (`src/report-tool-builder.ts`): `{ name, description, input: <.strict() zod schema>, annotations, handler }`. A tool that runs one GAM report over a `date_range` is built with `buildReportTool()`, which resolves and validates the date range before calling `executeReport()`, so no such tool can send GAM an unchecked date. `src/tools/index.ts` is the single registry — `SHARED_TOOLS` (every transport) plus `SAVED_QUERY_TOOLS` (stdio only). `src/server.ts` parses every tool call's arguments through one shared `tool.input.safeParse(...)`, rejecting any undeclared key, at any depth, as `INVALID_INPUT`.
- **The report path** (`src/report-exec.ts`, `src/report-reuse.ts`) follows GAM's async report model: create → poll → page. `findOrCreateReport()` names a report after the SHA-256 hash of its canonical definition (`src/report-key.ts`, `definitionHash()`) and reuses an existing report of that name instead of defining a new one; `pollUntilDone()` polls the run operation; results are paged via `next_cursor` (`fetchReportPage()`) rather than buffered whole into a tool response. **Reports are created `HIDDEN` and nothing in this codebase deletes one** — every distinct report shape (dimensions, metrics, filters, sort, and resolved date range) a caller ever asks for is a permanent object in the customer's GAM network. Four tools (`find_unused_ad_units`, `diagnose_fill_rate`, `diagnose_floor_pricing`, `find_anomalies`) resolve their window from the wall clock (`lastDays(...)`) instead of taking `date_range`, so each one defines a new hidden report every calendar day it runs — see README §Reliability before adding a fifth tool with the same shape.
- **The cache** (`src/cache.ts`, keyed by `definitionHash()`): an in-memory tier always, plus an optional on-disk tier at `GAM_REPORT_CACHE_DIR` (one JSON file per entry, surviving process restarts). What's cached is a **reference** to a GAM result — report name, result name, row count, run time — never row data; every call still pages its own rows from GAM. TTL is `GAM_REPORT_CACHE_TTL_MS` (default one hour; `0` disables reuse). A `pending` entry records an in-flight run, so a call that outlives its own `GAM_REPORT_TIMEOUT_MS` resumes the same GAM operation on retry instead of starting a second one.
