# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.2](https://github.com/standby/gam-mcp/compare/v0.6.1...v0.6.2) (2026-11-27)


### Fixed

* bound every array a tool accepts ([47a8118](https://github.com/standby/gam-mcp/commit/47a81187a273202c38019ffec7cca669e41ef805))
* **deps:** patch vulnerable dependencies and raise the MCP SDK floor ([43a1aaf](https://github.com/standby/gam-mcp/commit/43a1aaf5dcc364f8f177db82f8f2136e44785387))

## [0.6.1](https://github.com/standby/gam-mcp/compare/v0.6.0...v0.6.1) (2026-09-20)


### Fixed

* **readme:** the fill-rate example named a real-looking ad unit ([6ad08a5](https://github.com/standby/gam-mcp/commit/6ad08a54ad02029644f039e35092943666383546))

## [0.6.0](https://github.com/standby/gam-mcp/compare/v0.5.2...v0.6.0) (2026-09-20)


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

* advertise each tool input in full and name what is wrong with an input ([98c5f79](https://github.com/standby/gam-mcp/commit/98c5f79871b72505a33c7a7724dc4ccf3694da90))
* annotate every tool and offer saved queries over stdio only ([76837bd](https://github.com/standby/gam-mcp/commit/76837bd111f8f399b510ab463ab093729b0b5c3c))
* answer repeated reports from the cached result ([0c147b2](https://github.com/standby/gam-mcp/commit/0c147b2b44a1bfc5388b000259a7b1a665d68f05))
* check every date range in the date time zone ([15cb988](https://github.com/standby/gam-mcp/commit/15cb98816c1b3f05eb4b11cd11a635e5840960d9))
* compare two time zones' UTC offsets over a date range ([8e407cc](https://github.com/standby/gam-mcp/commit/8e407cc847e233b62ac725a89c351857c8cd1124))
* **compare_periods:** derived delta_pct instead of an empty-string sentinel ([269cd2a](https://github.com/standby/gam-mcp/commit/269cd2ac009508d00585cf17758f12ac8efb0244))
* decode GAM report values into typed cells ([e5f3bf0](https://github.com/standby/gam-mcp/commit/e5f3bf00592f3329933e466b4f34e539ffb00e52))
* find a report by name before creating one ([8fa642d](https://github.com/standby/gam-mcp/commit/8fa642d8671b252668447b9cdc0290177d563fdd))
* guard the HTTP endpoint with a bearer token, a host list and a body limit ([0219f0f](https://github.com/standby/gam-mcp/commit/0219f0f8b11ad61dca3a6c3aba45ddbbeadcd83a))
* keep result references in the report cache instead of rows ([13aaf35](https://github.com/standby/gam-mcp/commit/13aaf351230089001c020865c5a6b122747abf50))
* name each report after the hash of its definition ([8d389a1](https://github.com/standby/gam-mcp/commit/8d389a1a1c2e46407a03630d93f63271b2b3207a))
* name the calling tool in report logs ([4b732b7](https://github.com/standby/gam-mcp/commit/4b732b766581679d6b9c81cb9a9c7c43a88af427))
* one report path that returns typed pages with provenance ([e0a45b8](https://github.com/standby/gam-mcp/commit/e0a45b8c5d92e1ebbfc53214d48a1eb129574724))
* page report results with fetch_report_page ([d99f3dc](https://github.com/standby/gam-mcp/commit/d99f3dca0747fa93afe4e559b4aa98e366e9d02a))
* read the HTTP settings as strictly as the rest, and stop cleanly on a busy port ([4981541](https://github.com/standby/gam-mcp/commit/4981541c194a386fe41e8e1f9930525c10213c52))
* read the network with the configured credential before serving ([4fdc171](https://github.com/standby/gam-mcp/commit/4fdc17175dbd9df9e3c02fc82de9aa77d5c22fb8))
* refuse unknown tool arguments and describe every field ([24f10f0](https://github.com/standby/gam-mcp/commit/24f10f0b0fc055b55766de3b3d4b71bd4812d60c))
* report tools take any date range and check it by report type ([205d97b](https://github.com/standby/gam-mcp/commit/205d97b0b70b01bd0a677e62c6c8b1502ec58c0b))
* result envelope with qualifiers first, and page cursors ([0e2c89b](https://github.com/standby/gam-mcp/commit/0e2c89b84cadad345ed214a14c88c0d82e289fd3))
* run every report in the network's zone and currency, and say so ([9b96d5c](https://github.com/standby/gam-mcp/commit/9b96d5c40cea212735c1a1b81bf40c01bbad49b2))
* share identical runs and resume runs that outlive their caller ([c36c07b](https://github.com/standby/gam-mcp/commit/c36c07becd29acd5f709ff66830dd5c4a9b1d6eb))
* split report create/run and fetch result pages from GAM ([49491d2](https://github.com/standby/gam-mcp/commit/49491d2e0cbff17f91e1611fa525bf9241f5b178))
* **tools:** derived plumbing -- null-propagating arithmetic, DUPLICATE_JOIN_KEY ([5e922bb](https://github.com/standby/gam-mcp/commit/5e922bb7aab1cbe7c5b77116143da61384907403))
* **tools:** group by entity id beside the name, and refuse a duplicated join ([1e5fdce](https://github.com/standby/gam-mcp/commit/1e5fdce160c5c9069ffc5090e9832f2eb92926d1))
* **tools:** heuristics carry their method, their inputs and a heuristic flag ([5940fae](https://github.com/standby/gam-mcp/commit/5940fae62b5f228d14866550dced00e2635439d0))
* **tools:** pacing reports GAM's delivery indicator over a chosen range ([7e2472b](https://github.com/standby/gam-mcp/commit/7e2472b52cc11b829a6a2ed5fa7a84a4ca0b265e))
* **tools:** top_n sorts the report and returns the rows it promised ([21a32c2](https://github.com/standby/gam-mcp/commit/21a32c2b2796c21fe78cb61727759dd25e63681a))


### Fixed

* a call that finds a result gone no longer undoes another call's fresh run ([ae059f5](https://github.com/standby/gam-mcp/commit/ae059f51cdb2592f4a7c07b71dbdb9f9026229ce))
* a final page with no reported count knows its total ([3a3eb78](https://github.com/standby/gam-mcp/commit/3a3eb7831b3adf32fba97693775c3baf14025088))
* a malformed inline credential is reported without echoing it ([b1dc455](https://github.com/standby/gam-mcp/commit/b1dc455424bdf1e2f1374361e1e77d4ee898edfa))
* a resumed run whose result is gone runs again, and a shared run lasts until its result is recorded ([b9debe7](https://github.com/standby/gam-mcp/commit/b9debe7e3af53927fd4e4e2e7b0328765c3677b5))
* accept only this network's result references in the report cache ([07667a2](https://github.com/standby/gam-mcp/commit/07667a2d09c015850e27938b9f5c94a7acafe668))
* an inverted date range counts as differing, and tests say what they check ([c206d73](https://github.com/standby/gam-mcp/commit/c206d733863254411ac6a6e5daeddb1f88bc1e90))
* an unreported date range stays null, and stale comments go ([5fbf490](https://github.com/standby/gam-mcp/commit/5fbf490bd49095c0bcb8c8ed2394f8191ebe1549))
* build a new MCP server and transport per HTTP request ([#6](https://github.com/standby/gam-mcp/issues/6)) ([1a63668](https://github.com/standby/gam-mcp/commit/1a63668be2f4d9377ebf4b0e4475665a61bad5d0))
* check every report query against its report type before GAM sees it ([6bd92a0](https://github.com/standby/gam-mcp/commit/6bd92a0ff3e1451ef2518423c8de403ffb478296))
* close every tool call in the log and keep result keys in contract order ([e89a5f3](https://github.com/standby/gam-mcp/commit/e89a5f387e05120cab7183dfb4ee9b034d4eb9a5))
* **compare-periods:** one sentinel for a missing value, not two ([24ad066](https://github.com/standby/gam-mcp/commit/24ad06621908d7244c01279889abce6682cb42d1))
* **find-unused-ad-units:** only active, leaf ad units can be flagged as unused ([546e6f3](https://github.com/standby/gam-mcp/commit/546e6f39c3664c6697e907f1cf5d2b8b4552e4ad))
* **find-unused-ad-units:** warn in warnings, not only in summary, when the max_units cap is hit ([343da6c](https://github.com/standby/gam-mcp/commit/343da6ca9fa8ff981b8b2474fc1c8c24fb2d19fa))
* flag every tool error with isError ([38c656b](https://github.com/standby/gam-mcp/commit/38c656beaafee4e954a19673b54f39eb851512fa))
* **health-check:** classify a confirmed 404 as ENTITY_NOT_FOUND ([b3d9c51](https://github.com/standby/gam-mcp/commit/b3d9c5190aed447173f2db5c7657588fe280fff9))
* **http:** a refused body does not leave its connection stuck ([98e17e8](https://github.com/standby/gam-mcp/commit/98e17e80c59453689335201d568fc584a855fff0))
* **http:** every refusal gives its connection back, not just the 413 ([73ac3e8](https://github.com/standby/gam-mcp/commit/73ac3e843e88323fc327bb7e107f97b7ce3ae9fa))
* keep dimension and metric order in a report's identity ([2611b9e](https://github.com/standby/gam-mcp/commit/2611b9e9e5659db0d44b990baa1792ea0fbd4bd2))
* later pages report the server's facts and caveats, not the cursor's ([95e8a00](https://github.com/standby/gam-mcp/commit/95e8a005d5b6dd846302d0b5ee29d9ed19f4c1ba))
* name the definition keys that differ when a report name is taken ([f45ac9d](https://github.com/standby/gam-mcp/commit/f45ac9d7b718b527692f1ba09f2ff2f492858084))
* name the zone a stored report was counted in, and bound the zone check ([6d1c694](https://github.com/standby/gam-mcp/commit/6d1c694fba8c1c4b331d007459fe235bba39298e))
* never pass credential-library messages to logs or errors ([c777861](https://github.com/standby/gam-mcp/commit/c77786104b9973b9a3c0e49248f9fa117bfdf0cd))
* **prompts:** stop steering compare_periods into a bare *_NAME group-by ([4789d98](https://github.com/standby/gam-mcp/commit/4789d989d75425e3397539c00d3ca1d45a25da7d))
* quote the port in startup errors and refuse offset time zones ([1e2c9e7](https://github.com/standby/gam-mcp/commit/1e2c9e7d611828f3dff72da36a64ff36fa8a8c0a))
* record a pending run again if it left memory while its caller polled ([37ecfc3](https://github.com/standby/gam-mcp/commit/37ecfc313c5673b685cc59a581ab3d62482d98f9))
* record a report run as pending as soon as GAM accepts it ([12b303e](https://github.com/standby/gam-mcp/commit/12b303e538a9a60508583fca11469eaf16375fdd))
* report a key or ad unit name that matches more than one entity ([fe47a3a](https://github.com/standby/gam-mcp/commit/fe47a3aa82813f77c944c238a755c975cbb1ee05))
* **report-exec:** carry a caveat reminder onto later report pages ([930db32](https://github.com/standby/gam-mcp/commit/930db3241b136d6f03ace54eaa5b1918879669a2))
* **report-exec:** warn when executeReportRows reads fewer rows than GAM reported ([aaa3ffa](https://github.com/standby/gam-mcp/commit/aaa3ffaa20d365b9287560faf969c0b5e41062cb))
* retry a report POST only when GAM did not act on it ([fae1404](https://github.com/standby/gam-mcp/commit/fae14041c66b50c8a65fcfc14edc01748f081746))
* **saved-queries:** surface canonicalizeQuery's warnings from save_query ([7e1c9a0](https://github.com/standby/gam-mcp/commit/7e1c9a0a97c9c563288d43d4eac9be76dfa7aff2))
* say what went wrong at startup and when a report or result is gone ([ab9efe5](https://github.com/standby/gam-mcp/commit/ab9efe529579e0a0cbe3bf0534f3cfe079525a59))
* **schema:** resolve dimension aliases in filter fields too ([c19babb](https://github.com/standby/gam-mcp/commit/c19babb2b28413f5ed8c60abdcc5bcabb09501bc))
* **server:** a call whose result cannot be serialised is logged failed once ([e3f68c1](https://github.com/standby/gam-mcp/commit/e3f68c19eb911af62ae51254282a60a700c6c03b))
* **smoke:** gate find_unused_ad_units behind its own opt-in ([e3d8032](https://github.com/standby/gam-mcp/commit/e3d8032f886d4590bd63e97a2d58ab667d041202))
* sort a filter's values only when they form a set ([42974f4](https://github.com/standby/gam-mcp/commit/42974f497ed81a4696a31d81195fcd0eed23b899))
* **tools:** a failed health check is an error, and summaries name their filters ([e9e255a](https://github.com/standby/gam-mcp/commit/e9e255aef1d847ce057ca93da2f2afe3cff354b8))
* **tools:** count every row a null input actually nulled, and cover it ([115f3df](https://github.com/standby/gam-mcp/commit/115f3dfdb54489f2064ad2bc00ddbcff2c212ed1))
* **tools:** kv_report's summary stops doubling its filter clause, health_check classifies real HTTP status ([a161d6f](https://github.com/standby/gam-mcp/commit/a161d6f30b8c7839ceaf11044f29d72b98d237eb))
* **tools:** trust neither wire form for LINE_ITEM_UNLIMITED_END, and cover the gaps review found ([ea2e218](https://github.com/standby/gam-mcp/commit/ea2e2185624a83f2f9946efcc19abc074c196a50))
* **tools:** warning and summary text stop implying every null-input row is still visible ([9fab06f](https://github.com/standby/gam-mcp/commit/9fab06fd9710c47b09fe3e33715eb426550613f5))
* type GAM errors and keep the operation when a poll fails ([6ad7fee](https://github.com/standby/gam-mcp/commit/6ad7fee696dfbafd7e6bde23b52c75a96623ecf0))
* **values:** index dimensions and metrics separately; normalise a numeric intValue ([5160b66](https://github.com/standby/gam-mcp/commit/5160b66cfc9d6b3c24bc17cd10a1054e9a670a58))
* **zones:** say which part of a report's time zone this server cannot use ([4236135](https://github.com/standby/gam-mcp/commit/423613525133930148e35e8c978754288bd73b53))


### Changed

* build each report definition once and share the first-page step ([f58ed78](https://github.com/standby/gam-mcp/commit/f58ed78350f10258ac6f1186eb6b0f173e2d0e73))
* remove the CSV and file-path result path ([0465f37](https://github.com/standby/gam-mcp/commit/0465f3719dc9fe7c98317afc214a47264f923b1a))
* run_report, kv_report and pacing_status use the report path ([89b9231](https://github.com/standby/gam-mcp/commit/89b923183baf23622412473f7f31a7b06c1fee52))
* tools that compute from rows read typed pages and name their inputs ([dfbe42f](https://github.com/standby/gam-mcp/commit/dfbe42f2943ecbcf41980d6ed950220f9a253fa9))
* **tools:** name the stdio-only set once and test the property behind it ([68a1354](https://github.com/standby/gam-mcp/commit/68a1354febd22fea3583a333f268bc4762f46ab3))

## [0.5.2](https://github.com/standby/gam-mcp/compare/v0.5.1...v0.5.2) (2026-09-12)


### Fixed

* build a new MCP server and transport per HTTP request ([9e2cd95](https://github.com/standby/gam-mcp/commit/9e2cd955194d86623f0e44fa9ce0821323f10188))

## [0.5.1](https://github.com/standby/gam-mcp/compare/v0.5.0...v0.5.1) (2026-08-15)


### Added

* add describe_line_item tool ([6726a99](https://github.com/standby/gam-mcp/commit/6726a9917eaceb40124e861caaf0cdbe888c382b))


### Fixed

* bound path resolution and stop swallowing fetch failures ([630c458](https://github.com/standby/gam-mcp/commit/630c458dde5fc62d425aabe55aa94cb3e27b17ce))
* surface custom-targeting literal fields describe_line_item does not map ([3f5ee4e](https://github.com/standby/gam-mcp/commit/3f5ee4e156883958fa97e281f9abdb01dd263d82))
* use per-id direct GETs for all entity lookups ([76d2871](https://github.com/standby/gam-mcp/commit/76d28717de63585cf51834014529ced60c1815fa))

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

[Unreleased]: https://github.com/standby/gam-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/standby/gam-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/standby/gam-mcp/compare/v0.3.1...v0.4.0
[0.2.2]: https://github.com/standby/gam-mcp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/standby/gam-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/standby/gam-mcp/compare/v0.1.12...v0.2.0
[0.1.12]: https://github.com/standby/gam-mcp/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/standby/gam-mcp/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/standby/gam-mcp/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/standby/gam-mcp/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/standby/gam-mcp/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/standby/gam-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/standby/gam-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/standby/gam-mcp/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/standby/gam-mcp/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/standby/gam-mcp/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/standby/gam-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/standby/gam-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/standby/gam-mcp/releases/tag/v0.1.0
