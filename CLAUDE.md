# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project intent

This repo is a Node.js **MCP (Model Context Protocol) server** that exposes **Google Ad Manager (GAM)** as tools an LLM can call to collect analytics data for analysis. It is not a general GAM admin tool — the surface area should be biased toward read/report operations (running reports, fetching reports, listing/inspecting networks, orders, line items, creatives, inventory) rather than write/mutation operations.

## Hard constraints

- **Distribution:** must be runnable via `npx <package>` with zero clone/build steps. The `package.json` `bin` entry is the entrypoint; the `main`/`bin` script must be the MCP stdio server. Don't introduce a build step that breaks `npx` (no required `postinstall` compile, no missing `files` field).
- **Transport:** stdio MCP server by default. Logs go to stderr, never stdout — stdout is the MCP protocol channel and any stray write corrupts the session.
- **Auth:** GAM uses OAuth2 / service-account credentials. Credentials come from the user's environment (env vars or a path to a JSON key file passed in config) — never bundled, never logged, never echoed in tool responses.
- **GAM API:** Google Ad Manager exposes both a legacy SOAP Ad Manager API and the newer Ad Manager API (REST/gRPC). Pick one and document the choice in README; don't half-implement both. Reports in GAM are asynchronous (create job → poll → download) — tools that wrap reports must handle the polling shape, not pretend it's synchronous.

## Design guidelines for tools

- Tool names should read as verbs the LLM would pick from a list: `run_report`, `get_report_results`, `list_orders`, not `gamReportServiceCreateReportJob`.
- Each tool's input schema must have descriptions on every field — the schema is the LLM's only documentation.
- Return structured JSON, not pre-formatted text. The LLM consuming this MCP will format for the user.
- Paginate large results. GAM report rows can be enormous — stream/page rather than buffering whole CSVs into a tool response.

## Commit messages

- Do not add `Co-Authored-By: Claude` (or any other Claude/AI attribution) to commit messages. The author/committer fields are sufficient.
- Do not add `🤖 Generated with Claude Code` footers or similar tool-credit lines.
- Follow the repo's existing Conventional Commits style (`fix:`, `chore:`, `ci:`, `docs:`).

## When this file is out of date

Once code lands, replace these sections with the actual commands (`npm test`, lint, build, run-local), the chosen GAM API flavor, and the real architecture (transport layer, auth flow, tool registry pattern). Don't leave stale guidance — delete what no longer applies.
