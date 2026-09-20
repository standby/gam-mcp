# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1](https://github.com/standby/gam_mcp/compare/v0.6.0...v0.6.1) (2026-09-20)


### Fixed

* **readme:** the fill-rate example named a real-looking ad unit ([91e0314](https://github.com/standby/gam_mcp/commit/91e0314bb515a15f37a55956973debfc1358ba3e))

## [0.6.0](https://github.com/standby/gam_mcp/compare/v0.5.2...v0.6.0) (2026-09-20)


### ⚠ BREAKING CHANGES

* **compare-periods:** compare_periods returns null rather than an empty string for a metric that has no value in one of the two periods.
* **health-check:** health_check reports a confirmed 404 from GAM (a real HTTP status on the listEntities check) as error.code ENTITY_NOT_FOUND instead of INTERNAL_ERROR. attributed_cause's text is unchanged. The message-heuristic fallback path (no typed HTTP status available) is unaffected and still reports INTERNAL_ERROR for a "404"-mentioning message.
* **compare_periods:** compare_periods' `<metric>_delta_pct` field changes from a plain string (e.g. "25.00", "", "0") to a derived object ({value, method, heuristic, inputs}); callers reading it as a formatted string must read `.value` instead, which is a number or null. A row with a metric missing on one side, or with prev exactly 0 and a nonzero current value, now has `.value: null` instead of the delta_pct key being ''. compare_periods now also emits a "N row(s) had a null input to a computed field" warning when that happens, which it never did before.
* **tools:** health_check returns isError: true on failure instead of a successful envelope whose first row said status: "failed". Callers parsing that row must read the error body (error.code, error.details) instead.
* **find-unused-ad-units:** find_unused_ad_units returns a narrower row set. Archived ad units and parent containers no longer appear, because neither can be unused inventory -- a caller that relied on the old, incorrect behaviour now silently receives fewer rows for the same network.
* **tools:** diagnose_fill_rate and diagnose_floor_pricing move their per-row cause/est_opportunity fields under a `derived` object; callers reading `cause` or `est_opportunity` as top-level fields must read `derived.value` instead. diagnose_floor_pricing's `verdict` can now be null when AdX match rate or eCPM wasn't reported. find_anomalies' fill_rate_drops and viewability_drops rows lose the `drop_pp` field entirely, and ecpm_regression rows lose `drop_pct` entirely -- these were real, pushed JSON fields, not internal variable names -- and the same week-over-week drop magnitude now lives only at `derived.value`, alongside `derived.method` and `derived.inputs`. diagnose_fill_rate's `fill_rate_pct` changes its source under an unchanged name: the query no longer asks GAM for `FILL_RATE` -- `IMPRESSIONS` replaces it -- and the field is now computed locally as IMPRESSIONS / AD_REQUESTS and published under the same `fill_rate_pct` key, so a caller diffing this number release-to-release will see a different value with no field-name signal that anything changed. Several numeric display fields that were always present in 0.5.2 (its zero-fallbacks printed "0.00" rather than omitting the field) can now be `null` when GAM didn't report the underlying metric: on diagnose_fill_rate, `fill_rate_pct`, `adx_request_share_pct`, `adx_match_rate_pct`, `direct_response_share_pct`, `unfilled_share_pct`, `ad_requests` and `unfilled_impressions`; on diagnose_floor_pricing, `adx_match_rate_pct`, `adx_ecpm`, `adx_impressions` and `adx_revenue`.
* **tools:** pacing_status gains a date_range input (default last_7_days). Its output changes from a two-dimension LINE_ITEM_NAME/LINE_ITEM_ID + IMPRESSIONS/REVENUE passthrough to eleven line-item dimensions plus delivery_indicator and a derived block; REVENUE is dropped from its output (spec §4.3 requests only IMPRESSIONS). Provenance changes from a single report/result to inputs-style (DerivedProvenance). pacing_status itself never had computed pacing columns -- the computed month-to-date percentage lived in find_anomalies pacing_underdelivery, which now flags lifetime-goal line items by GAM's delivery indicator over last_7_days instead.
* **tools:** top_advertisers, top_line_items, revenue_summary, revenue_trend, inventory_breakdown, fill_rate, ad_speed, bidder_breakdown, video_breakdown, viewability_breakdown and yield_breakdown each gain an ID column, and rows that GAM previously merged under one name are now separate. Definition hashes change. compare_periods returns DUPLICATE_JOIN_KEY where it used to return a silently merged row.
* **tools:** top_advertisers, top_line_items, kv_breakdown, bidder_breakdown, yield_breakdown, video_breakdown and viewability_breakdown now return at most top_n rows, sorted descending by the metric named in summary, instead of up to GAM_PAGE_ROWS rows in GAM's order. provenance.sort is no longer empty, and the definition hash changes, so the first call after upgrading defines a new report per tool and shape.
* GAM_HTTP_PORT, GAM_PAGE_ROWS, GAM_REPORT_TIMEOUT_MS and GAM_REPORT_CACHE_TTL_MS accept digits only; a value such as 3e5 or 8080.0 now stops startup.
* HTTP mode no longer lists or runs save_query, list_saved_queries, run_saved_query and delete_saved_query, and the gam://network resource replaces timezone with report_time_zone and date_time_zone.
* an argument a tool does not declare, at any depth, is INVALID_INPUT naming the key instead of being dropped.
* report tools refuse impossible dates and an end date after yesterday, and sell_through refuses a window that starts before today or is given as a relative range.
* the relative range today is removed; month_to_date, quarter_to_date and year_to_date are INVALID_DATE_RANGE on the first day of their period; impossible dates such as 2026-02-30 are refused.
* GAM_REPORT_CACHE_TTL_MS now applies to the in-memory cache as well as the disk tier (default one hour; 0 turns result reuse off), and GAM_REPORT_CACHE_DIR holds result references in <dir>/<network code>/; row files written by 0.5.x are ignored.
* startup fails when the credential cannot read the network. GAM_TIMEZONE defaults to the network's time zone instead of UTC. An unknown GAM_TIMEZONE, a GAM_NETWORK_CODE that is not a number, a GAM_REPORT_TIMEOUT_MS that is not a positive whole number, or a GAM_REPORT_CACHE_TTL_MS that is not a non-negative whole number stops startup instead of being used as given.
* error envelopes that a tool returns (REPORT_FAILED, REPORT_TIMEOUT, INVALID_DATE_RANGE and the rest) now arrive with
* report tools no longer return file_path or preview_rows. Large results are paged: pass next_cursor to fetch_report_page. row_count is replaced by total_row_count and returned_row_count, row values are typed (numbers, booleans, ISO dates, null for missing), and schema types are real. GAM_INLINE_ROW_THRESHOLD is ignored; set GAM_PAGE_ROWS.

### Added

* advertise each tool input in full and name what is wrong with an input ([cf241aa](https://github.com/standby/gam_mcp/commit/cf241aa67cba0a061a3b46b1387f2f5e92fad166))
* annotate every tool and offer saved queries over stdio only ([c134b66](https://github.com/standby/gam_mcp/commit/c134b6681a85ae2e9d98b76448c7c0c27dad06db))
* answer repeated reports from the cached result ([d522e09](https://github.com/standby/gam_mcp/commit/d522e09c54241b5ae284084044d742c67664c3f1))
* check every date range in the date time zone ([adeb21f](https://github.com/standby/gam_mcp/commit/adeb21f2b08faa5e914752348bc9460a6cc1365f))
* compare two time zones' UTC offsets over a date range ([82102c8](https://github.com/standby/gam_mcp/commit/82102c8c451a6031b4f8e8f5fa952e45d4da2b1d))
* **compare_periods:** derived delta_pct instead of an empty-string sentinel ([348c017](https://github.com/standby/gam_mcp/commit/348c01745a593cb01d9834739be81eb51971d6a6))
* decode GAM report values into typed cells ([c34dcfc](https://github.com/standby/gam_mcp/commit/c34dcfc6073f1359c1d769857b44ae1dcdde2743))
* find a report by name before creating one ([c13c93c](https://github.com/standby/gam_mcp/commit/c13c93c8110f9c8eda8467b00d75f7c706273cff))
* guard the HTTP endpoint with a bearer token, a host list and a body limit ([cde498d](https://github.com/standby/gam_mcp/commit/cde498d175709e4799a2bc222b0ed50641d2341d))
* keep result references in the report cache instead of rows ([0d4d1ae](https://github.com/standby/gam_mcp/commit/0d4d1ae9224305bf75dcca35fe257d000a598aa9))
* name each report after the hash of its definition ([5d865f3](https://github.com/standby/gam_mcp/commit/5d865f361c73eceb53438f880e6e1164f5ef9947))
* name the calling tool in report logs ([0386257](https://github.com/standby/gam_mcp/commit/0386257ca2e388d0503745701e07faa2dbd7a00f))
* one report path that returns typed pages with provenance ([f3f149d](https://github.com/standby/gam_mcp/commit/f3f149dab6957bbe2ff643be9daceb71abcb6d3c))
* page report results with fetch_report_page ([fa4c32b](https://github.com/standby/gam_mcp/commit/fa4c32b8e059580189e4e3cc59f7129d38dede31))
* read the HTTP settings as strictly as the rest, and stop cleanly on a busy port ([897331f](https://github.com/standby/gam_mcp/commit/897331fd350e9f1482355bdeecf81899feedad1b))
* read the network with the configured credential before serving ([cac673a](https://github.com/standby/gam_mcp/commit/cac673af740c1f95a3578357d7a976aab7b1e914))
* refuse unknown tool arguments and describe every field ([57f7fb5](https://github.com/standby/gam_mcp/commit/57f7fb5224c06c930463dc38c5539040687675a4))
* report tools take any date range and check it by report type ([09a26a2](https://github.com/standby/gam_mcp/commit/09a26a2d191547b60f7ec4d4af8dcc7167549f20))
* result envelope with qualifiers first, and page cursors ([8c5aa91](https://github.com/standby/gam_mcp/commit/8c5aa91e2a4b9307122ccf5815474ece1f16d8cf))
* run every report in the network's zone and currency, and say so ([9d1799b](https://github.com/standby/gam_mcp/commit/9d1799b514953527c7ba5a33fbeea8e6332bf85b))
* share identical runs and resume runs that outlive their caller ([e11472b](https://github.com/standby/gam_mcp/commit/e11472b3e5b79d318a624d781168c3b62b64c962))
* split report create/run and fetch result pages from GAM ([3be6131](https://github.com/standby/gam_mcp/commit/3be61319a7b498df78390fd695747ab0aab6463c))
* **tools:** derived plumbing -- null-propagating arithmetic, DUPLICATE_JOIN_KEY ([6853795](https://github.com/standby/gam_mcp/commit/6853795c0584a8b7153ac4736c4fb5e39ed9bed0))
* **tools:** group by entity id beside the name, and refuse a duplicated join ([9e7057d](https://github.com/standby/gam_mcp/commit/9e7057d28733a5e0e016a61b3a837ae7eb01003d))
* **tools:** heuristics carry their method, their inputs and a heuristic flag ([fff1731](https://github.com/standby/gam_mcp/commit/fff1731dd034ee7b27df25e5f0bc490883aff3ce))
* **tools:** pacing reports GAM's delivery indicator over a chosen range ([b757312](https://github.com/standby/gam_mcp/commit/b757312dfd7d2aafb33b934a7761146dd08cc780))
* **tools:** top_n sorts the report and returns the rows it promised ([bcd9e2c](https://github.com/standby/gam_mcp/commit/bcd9e2cfae95c8ab31fc7a7bc10db3a524a22dd7))


### Fixed

* a call that finds a result gone no longer undoes another call's fresh run ([19b084f](https://github.com/standby/gam_mcp/commit/19b084fd5938adc50d43c211e6dce2752c867a6d))
* a final page with no reported count knows its total ([820764b](https://github.com/standby/gam_mcp/commit/820764b7a4dc71fa599f92d338412cedd0f14f3b))
* a malformed inline credential is reported without echoing it ([c1afb5e](https://github.com/standby/gam_mcp/commit/c1afb5ed66f8e14353caee1891d0c8fd38bcdd90))
* a resumed run whose result is gone runs again, and a shared run lasts until its result is recorded ([3997bc7](https://github.com/standby/gam_mcp/commit/3997bc747410b23f5d848379a54f44e8b0d30156))
* accept only this network's result references in the report cache ([5843720](https://github.com/standby/gam_mcp/commit/5843720462b52a6e3207f1d6f5fa26b6b3b49f34))
* an inverted date range counts as differing, and tests say what they check ([ab7cbf2](https://github.com/standby/gam_mcp/commit/ab7cbf201f22cf92d957ceb23081a92ef02eb427))
* an unreported date range stays null, and stale comments go ([7f6a7e3](https://github.com/standby/gam_mcp/commit/7f6a7e3d471c5e50e3c938ba3e988f6ef013d103))
* build a new MCP server and transport per HTTP request ([#6](https://github.com/standby/gam_mcp/issues/6)) ([8eb94f2](https://github.com/standby/gam_mcp/commit/8eb94f245db248a99252df9e0cf51284ff3b0047))
* check every report query against its report type before GAM sees it ([f0468f3](https://github.com/standby/gam_mcp/commit/f0468f3db8aac932a986c2ca3334df80ebcc9538))
* close every tool call in the log and keep result keys in contract order ([66e0bf2](https://github.com/standby/gam_mcp/commit/66e0bf2d5d35e11f4d66b27afd9ba718d336190d))
* **compare-periods:** one sentinel for a missing value, not two ([18a6ad7](https://github.com/standby/gam_mcp/commit/18a6ad71dd3bfddcad81cfa45492f9cd209f5325))
* **find-unused-ad-units:** only active, leaf ad units can be flagged as unused ([b51280d](https://github.com/standby/gam_mcp/commit/b51280dfea994c1744e4787b5e732be07d561386))
* **find-unused-ad-units:** warn in warnings, not only in summary, when the max_units cap is hit ([16051f1](https://github.com/standby/gam_mcp/commit/16051f13b82fa1ef965edd22883323d2443faee1))
* flag every tool error with isError ([9f573a7](https://github.com/standby/gam_mcp/commit/9f573a77baee52dccd4f9e391a85cb3099c10f36))
* **health-check:** classify a confirmed 404 as ENTITY_NOT_FOUND ([e0f3ea5](https://github.com/standby/gam_mcp/commit/e0f3ea522b6e2729036378bb46c8a4f319d09818))
* **http:** a refused body does not leave its connection stuck ([71283e4](https://github.com/standby/gam_mcp/commit/71283e44c17c6655d6555277ec9a1a525bf4e0da))
* **http:** every refusal gives its connection back, not just the 413 ([2e46e8a](https://github.com/standby/gam_mcp/commit/2e46e8a9dee8bfa21fc3867d4b2ac0a3cb9ec09e))
* keep dimension and metric order in a report's identity ([78b7dcb](https://github.com/standby/gam_mcp/commit/78b7dcb76beb749404c3121094b1d93e1a5bf8bc))
* later pages report the server's facts and caveats, not the cursor's ([6b495bd](https://github.com/standby/gam_mcp/commit/6b495bdbe8d46e5f28c8f7003401bba7a9bf1a53))
* name the definition keys that differ when a report name is taken ([61898b7](https://github.com/standby/gam_mcp/commit/61898b73aeb685b5d98566294dfe1e6a13a4cbde))
* name the zone a stored report was counted in, and bound the zone check ([521b0cb](https://github.com/standby/gam_mcp/commit/521b0cb9fda2e787dbfb54555fa3e21b5fe20f7e))
* never pass credential-library messages to logs or errors ([cfdf57e](https://github.com/standby/gam_mcp/commit/cfdf57e324d81fc7eeb1903c76810801e058b00e))
* **prompts:** stop steering compare_periods into a bare *_NAME group-by ([dc7e224](https://github.com/standby/gam_mcp/commit/dc7e224ac613094200632b71400a0ebea43314e5))
* quote the port in startup errors and refuse offset time zones ([c5f31b2](https://github.com/standby/gam_mcp/commit/c5f31b276c4a942359aee1e415e2c0b810e98d5f))
* record a pending run again if it left memory while its caller polled ([3ff9cf5](https://github.com/standby/gam_mcp/commit/3ff9cf55d5700617785ec177639ce3173526119b))
* record a report run as pending as soon as GAM accepts it ([4376ac7](https://github.com/standby/gam_mcp/commit/4376ac73aad979cc297ced95fa7a57163ae31646))
* report a key or ad unit name that matches more than one entity ([31191e5](https://github.com/standby/gam_mcp/commit/31191e52352e183c75a29e00807ecddf8df33c33))
* **report-exec:** carry a caveat reminder onto later report pages ([a1aca21](https://github.com/standby/gam_mcp/commit/a1aca2176af8efa4682ccd2b23689e58a2f546a5))
* **report-exec:** warn when executeReportRows reads fewer rows than GAM reported ([0470b44](https://github.com/standby/gam_mcp/commit/0470b448aa6c7f4a6e557b973934b6e6cb726439))
* retry a report POST only when GAM did not act on it ([1cd5a32](https://github.com/standby/gam_mcp/commit/1cd5a32813031e84a83a6862f44018e91d04597e))
* **saved-queries:** surface canonicalizeQuery's warnings from save_query ([d69695c](https://github.com/standby/gam_mcp/commit/d69695c63de7b837d44521a83234ef83ed17d9d3))
* say what went wrong at startup and when a report or result is gone ([2d5a53f](https://github.com/standby/gam_mcp/commit/2d5a53fa0c06a4c3467fa44b6c28966a1c9139b8))
* **schema:** resolve dimension aliases in filter fields too ([decf9d8](https://github.com/standby/gam_mcp/commit/decf9d8ceca2e66f00485d2ee3a49982d5f96fb8))
* **server:** a call whose result cannot be serialised is logged failed once ([799a0f7](https://github.com/standby/gam_mcp/commit/799a0f723816f841886cb686e7fa169e6e7c9204))
* **smoke:** gate find_unused_ad_units behind its own opt-in ([a64cbbe](https://github.com/standby/gam_mcp/commit/a64cbbe33c24ddc2e2f835091cdb6ac070f6a5ce))
* sort a filter's values only when they form a set ([c9c1b56](https://github.com/standby/gam_mcp/commit/c9c1b561e88485f9813e6c9cfcf520ee7641848e))
* **tools:** a failed health check is an error, and summaries name their filters ([cd23a81](https://github.com/standby/gam_mcp/commit/cd23a81dca2135c4be4320b81ce4c20eb0e63632))
* **tools:** count every row a null input actually nulled, and cover it ([b066f1b](https://github.com/standby/gam_mcp/commit/b066f1b52ab7017165c07ee38d03ff859d5b36a0))
* **tools:** kv_report's summary stops doubling its filter clause, health_check classifies real HTTP status ([b2c1fe4](https://github.com/standby/gam_mcp/commit/b2c1fe486202e61acc1bd5bc39592e068a620a9e))
* **tools:** trust neither wire form for LINE_ITEM_UNLIMITED_END, and cover the gaps review found ([bd3fdce](https://github.com/standby/gam_mcp/commit/bd3fdcef19282bd65ae14179df4d19f19d5c8bca))
* **tools:** warning and summary text stop implying every null-input row is still visible ([0ea54e7](https://github.com/standby/gam_mcp/commit/0ea54e739abe45868e798264902b468f0c579e55))
* type GAM errors and keep the operation when a poll fails ([2719cb9](https://github.com/standby/gam_mcp/commit/2719cb9c985a77c8e6da2ed5e6c2bc7bdc6d91f1))
* **values:** index dimensions and metrics separately; normalise a numeric intValue ([7f2692c](https://github.com/standby/gam_mcp/commit/7f2692c0ffa2a7fdaffc804871c3c5f8f893260c))
* **zones:** say which part of a report's time zone this server cannot use ([20143b8](https://github.com/standby/gam_mcp/commit/20143b882b267554bcbb0df2d6d76df75f1c2c0b))


### Changed

* build each report definition once and share the first-page step ([13db9fc](https://github.com/standby/gam_mcp/commit/13db9fcf098a15103550c790c0e2e90d81cf4617))
* remove the CSV and file-path result path ([7358482](https://github.com/standby/gam_mcp/commit/7358482609e6a0e659106c669ac52b1659862392))
* run_report, kv_report and pacing_status use the report path ([8201dc1](https://github.com/standby/gam_mcp/commit/8201dc126d02e722ff932d1805da20789638da06))
* tools that compute from rows read typed pages and name their inputs ([ebffa22](https://github.com/standby/gam_mcp/commit/ebffa22f3762f6184a28e7920cccd29d2dabe54b))
* **tools:** name the stdio-only set once and test the property behind it ([b640555](https://github.com/standby/gam_mcp/commit/b6405555d2e12a7945a265b27b594ca0a5d03573))

## [0.5.2](https://github.com/standby/gam_mcp/compare/v0.5.1...v0.5.2) (2026-09-12)


### Fixed

* build a new MCP server and transport per HTTP request ([d8a4755](https://github.com/standby/gam_mcp/commit/d8a4755499cc1dcfc3a1224d559f3e42e9d76627))

## [0.5.1](https://github.com/standby/gam_mcp/compare/v0.5.0...v0.5.1) (2026-08-15)


### Added

* add describe_line_item tool ([9767d1c](https://github.com/standby/gam_mcp/commit/9767d1cf4910915f2c8804c1404ee383749d8329))


### Fixed

* bound path resolution and stop swallowing fetch failures ([f9fb906](https://github.com/standby/gam_mcp/commit/f9fb906))
* surface custom-targeting literal fields describe_line_item does not map ([d54ae11](https://github.com/standby/gam_mcp/commit/d54ae11359d0ec8f48236253aa5d572818ecd6b1))
* use per-id direct GETs for all entity lookups ([59a1e0a](https://github.com/standby/gam_mcp/commit/59a1e0ae8af734dcd799349f29fac5e22bcc6cf7))

## [Unreleased]

## [0.5.0] — 2026-07-28

Complete coverage of the GAM REST report schema, generated from Google's
`report_definition.proto` rather than hand-maintained, plus one tool for each
remaining report type.

### Added
- **Generated schema** — `src/schema-generated.ts` carries the full REST enums
  (526 metrics, 764 dimensions, 12 report types), each with its report-type
  compatibility and data format. Whitelist coverage goes from 64/526 metrics
  and 58/764 dimensions to complete, so `run_report` no longer refuses names
  GAM accepts.
- **`reach_report`** (`REACH`) — unique visitors, reach impressions, and
  average impressions per unique visitor: the evidence base for setting a
  frequency cap. Unique counts are not additive across rows, which the response
  envelope warns about.
- **`ad_speed`** (`AD_SPEED`) — creative load-time buckets, the page/tag timing
  funnel, and unviewed reasons. The causal counterpart to
  `viewability_breakdown`, which shows only the symptom.
- **`sell_through`** (`FUTURE_SELL_THROUGH`) — forecasted, reserved, and
  available impressions plus sell-through rate over a future window; the
  forward half of `pacing_status`.
- **`consent_messaging`** (`PRIVACY_AND_MESSAGING`) — messages shown and user
  responses across six independently-configured message families.
- **`npm run schema:gap`** (`scripts/schema-gap.ts`) — diffs the whitelist
  against the proto in both directions: names GAM has that we lack, and names
  we whitelist that GAM no longer declares.
- **`describe_schema` filters** — `report_type`, `family`, and `search`, with
  the row budget split per kind and truncation announced. An unfiltered call
  returns names and types only; 1290 entries with prose would otherwise swamp
  the caller's context.
- **`custom_targeting_key` lookup** — per-id GETs for resources whose numeric
  id field is not filter-eligible, plus a substring-to-exact filter fallback.

### Changed
- Report type is derived rather than hardcoded: `resolveReportType` intersects
  the compatibility lists of every requested dimension and metric. Mixing
  families is now rejected locally with a message naming which side wants which
  type, instead of surfacing as a GAM 400.
- Curated prose and the observed incompatibility matrix moved to
  `src/schema-overrides.ts` and are merged over the generated entries by name,
  so `npm run refresh-schema` cannot clobber them.

### Fixed
- Dropped `TAXONOMY_CATEGORY` and `TAXONOMY_CATEGORY_ID`. They were whitelisted
  by hand but have never existed in the REST `Dimension` enum, so `validateCombo`
  passed and GAM rejected the request — a failure only visible against the live
  API. A new test fails on any override that stops matching a generated entry.
- `refresh-schema` counts brace depth when parsing proto enums. The previous
  `\{([^}]+)\}` match stopped at the first `}` inside a doc comment, silently
  truncating the enum and reporting live names as missing.

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

[Unreleased]: https://github.com/standby/gam_mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/standby/gam_mcp/compare/v0.4.0...v0.5.0
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
