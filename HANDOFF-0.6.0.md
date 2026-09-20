# gam-mcp 0.6.0 — handoff (updated 2026-09-20)

**0.6.0 is code-complete, pushed, and waiting on one local test.** Nothing is published; npm still
serves 0.5.2. Resume in `~/workspace/gam_mcp`; the release branch has a worktree at
`../gam_mcp-release`.

| | |
|---|---|
| Branch | `release/0.6.0`, pushed, `b404771` + this commit |
| PR | **[#12](https://github.com/standby/gam_mcp/pull/12)** → `main`, OPEN, `MERGEABLE`, **not merged** |
| Breaking-change footers in #12's body | **18**, verified *after* the round-trip to GitHub |
| Superseded PRs | #7 #8 #9 #10 — commented and closed; every commit is contained in `release/0.6.0` |
| Tests | 985 / 79 files; `typecheck`, `build`, `verify:pack` clean |
| `package.json` version | still `0.5.2` — release-please owns that field, do not hand-bump it |

## The release chain — where the irreversible step is

```
merge #12 into main  → release-please opens a "Release v0.6.0" PR   (safe, no publish)
merge THAT PR        → tags v0.6.0 → publish.yml → npm publish      (irreversible)
```

**This repo runs no CI on pull requests.** Neither workflow has a `pull_request` trigger, so #12
will never show a check. Local validation is all there is until `publish.yml` runs typecheck +
tests + build at tag time.

**Squash vs merge commit is a real choice.** A merge commit keeps all 122 commits, so release-please
generates ~75 changelog entries with all 18 breaking changes. A squash collapses it to one entry and
takes the breaking changes from the PR body only — which is why the body carries all 18 verbatim.
Given that ~three-quarters of the `fix:` entries are this release repairing its own unreleased code,
the squash may read better. Either works; the body survives both.

## What is on the branch

| PR | Branch | What it did |
|----|--------|-------------|
| 1 | `feat/0.6.0-report-path` | typed report path, paging, `fetch_report_page` |
| 2 | `feat/0.6.0-identity-cache` | startup identity check, two-tier result cache, report reuse |
| 3 | `feat/0.6.0-inputs-http` | strict tool inputs, date rules, HTTP transport and its boundary |
| — | `feat/0.6.0-smoke` | `npm run smoke:transports` — drives `dist/cli.js` over stdio and HTTP |
| 4 | `feat/0.6.0-tool-correctness` | `top_n`, `derived` blocks, IDs beside names, pacing, heuristics |
| 5 | `feat/0.6.0-docs-release` | README rewrite, spec amendments, release notes, `CLAUDE.md` |

Plus `design/0.6.0` (this file, `tasks/lessons.md`, the two scope documents). The publisher-data
scrub is in every commit — the network code, two report ids, two result ids, the network's real zone
and currency, and the owner's deployment zone are gone by content rewrite. Backups and
`refs/original/*` are deleted; **no recovery path exists**, so an older clone must be re-cloned.

`docs/superpowers/RELEASE-NOTES-0.6.0.md` carries what the changelog cannot say for itself: the
32-of-43 self-repair accounting, the seven footerless breaking changes, and the verified `awk`
command that extracts all 18 footers.

## Testing it locally before merging — the state left behind

A 0.6.0 tarball is built and installed, so the local test needs no rebuild:

- `~/workspace/gam-mcp-0.6.0.tgz` (218 KB, 195 files, `verify:pack` PASS)
- `gam-mcp@0.6.0` installed globally at `/opt/homebrew/bin/gam-mcp`

The version was bumped to 0.6.0 only to pack, then reverted — the tree is clean.

**`npx` resolution, measured, not assumed:**

| invocation | runs |
|---|---|
| `/opt/homebrew/bin/gam-mcp` | 0.6.0 |
| `npx -y gam-mcp@latest` | **0.5.2** — `@latest` is a registry tag; no local install can satisfy it |
| `npx -y gam-mcp` | 0.6.0 (finds the global install) |
| `npx -y -p ~/workspace/gam-mcp-0.6.0.tgz gam-mcp` | 0.6.0 (explicit; no global install needed) |

The existing `google-ad-manager` MCP entry runs `npx -y gam-mcp@latest`, i.e. 0.5.2. To test 0.6.0,
add a second entry (leave the working one alone) using the same three env values already in that
entry — do it with `claude mcp add`, not by editing `~/.claude.json` while Claude Code is running.

**Version probe, credential-free:** run the binary with `GAM_NETWORK_CODE=1`,
`GAM_SERVICE_ACCOUNT_KEY_FILE=/nonexistent`, `GAM_TIMEZONE=+08:00`. 0.6.0 exits 2 with "is not an
IANA time zone name"; 0.5.2 accepts the offset and proceeds to auth. Never touches a real credential.

**Cleanup after testing:** `npm uninstall -g gam-mcp`. While it is installed, `npx -y gam-mcp`
keeps resolving to it even after 0.6.0 publishes — a stale local build that looks current.

## Decisions already made — do not re-litigate

- **Offset-form `GAM_TIMEZONE` stays refused** (asked 2026-09-20, answered: keep it). A frozen
  offset is not a zone; `-05:00` meaning New York gives the right day boundary in January and the
  wrong one from March to November, silently, in every report. `Etc/GMT-8` remains accepted for a
  genuine fixed offset — note the POSIX sign inversion, `Etc/GMT-8` is UTC**+**8.
- **The other breaking changes stand for the same reason**: 0.5.2's acceptance was the defect
  (silent first match on an ambiguous name, unknown tool arguments ignored, `health_check` returning
  a success envelope on failure). Strict inputs are the one debatable-on-ergonomics item — they
  reject typo'd keys that used to be silently dropped.
- **No publisher data in any file, doc or commit** (owner instruction, categorical). This handoff
  deliberately refers to the MCP config's env values rather than repeating them.

## Live verification — done 2026-09-20

0.6.0 was installed from the packed tarball, wired into Claude Code as a second MCP entry beside
the 0.5.2 one, and exercised against a live network. Everything passed:

| check | result |
|---|---|
| tool count | 33 — 29 shared + 4 saved-query, as expected for 0.6.0 (0.5.2 served 32) |
| `health_check` | pass, ~1.8 s — auth, network and permissions |
| `describe_schema` | filtered search returns matches with descriptions auto-enabled |
| `lookup` | real entity read, ids and display names |
| strict inputs | a misspelled key returns `INVALID_INPUT` naming it — 0.5.2 dropped it silently |
| `list_saved_queries` | responds, proving the stdio-only registry loaded |
| report path | create → poll → page, full provenance block, 7 rows, no truncation |
| **report reuse** | a second identical call returned `cache.hit: true` with the same report name, the same result name and the same run time — it reused the report instead of defining a second |

Cost of the whole exercise: **one** new hidden report object, because the date range was pinned.

**A zone warning correctly did NOT appear, and that is worth remembering.** The network counts days
in one zone and `GAM_TIMEZONE` chooses dates in another, but both share a UTC offset and neither
observes DST, so the offsets agree on every day in the range. `src/zones.ts` warns only when the
offsets actually diverge. Empty `warnings` here is the feature working. Do not "fix" it.

## Do these next

1. **Merge #12 into `main` with a merge commit** — decided, not squash. A merge commit keeps all
   122 commits, so release-please generates the full changelog and surfaces all 18 breaking changes
   from the commits themselves. (The PR body carries them too, which a squash would have needed.)
2. **Let release-please open "Release v0.6.0", then merge it.** That tags `v0.6.0`, which triggers
   `publish.yml` → `npm publish`. **That is the irreversible step.**
3. **Clean up:** `npm uninstall -g gam-mcp` (while it is installed, `npx -y gam-mcp` keeps resolving
   to it even after 0.6.0 publishes), remove the temporary `gam-mcp-060` MCP entry, restore
   `@latest` on the main entry, and delete the per-task worktrees (`../gam_mcp-0.6.0-pr1` …
   `-pr5`, `-smoke`, `../gam_mcp-release`) and their branches.
4. **Then the original request:** port the GA4 and GAM MCP servers into
   `~/workspace/ask-data-agent`. Known inputs: a `GAM_TIMEZONE` that differs from the
   network's own zone (deliberate, must keep working, and verified above); `GAM_REPORT_TIMEOUT_MS`
   below that client's 120 s; bearer token as `${GAM_MCP_TOKEN}`; `describe_line_item` treated as
   sensitive.

Spec §9 holds the rest of the follow-ups: per-request GAM timeout, a `date_range` input and
structured `listed`/`excluded` counts for `find_unused_ad_units`, `AdUnit.hasChildren` confirmation,
and the `derived.value` semantic ambiguity.

## The one operational fact a publisher needs

Running a report tool **defines a report object in the customer's GAM network**. The REST API creates
it `HIDDEN` and offers **no delete**. Reports are named after their definition hash, so identical
queries reuse one — but **the resolved date range is part of that hash**, so a rolling window mints a
new report every day. **Four tools cannot be pinned at all**: `find_unused_ad_units`,
`diagnose_fill_rate` and `diagnose_floor_pricing` take only `lookback_days`; `find_anomalies` takes
no window input and hardcodes seven days. Each defines a fresh, undeletable report on every calendar
day it runs. Documented in the README, spec §9 and the release notes.

## Where the records are

Each PR's SDD workspace survives at `<worktree>/.superpowers/sdd/<plan-basename>/progress.md` —
**read the ledger first; it holds every ruling and every deferred item.** PR 4's also records the
live-smoke result and four cases where the controller's own instructions were wrong.

`tasks/pr4-scope.md` and `tasks/pr5-scope.md` are the scoping outputs. `tasks/probe-0.6.ts` is the
live-probe script (now reads its report resources from the environment); keep it until 0.6.0 ships —
it is how a spec question gets an answer instead of a guess.

## Rules learned the hard way

1. **No AI attribution anywhere** — commits *and* PR bodies. One implementer added a footer by
   reflex and had to amend it out. Scan before every commit.
2. **Never type a `\u` escape into an Edit/Write tool argument.** Tool arguments are JSON, so it
   decodes into a raw control byte. Use `python3` with `chr()`.
3. **Verify self-reported deviations.** Four implementer reports on PR 4 made claims that did not
   survive a grep — including one that said `kv_report` was unaffected when it had a live regression.
4. **Absence is not permission.** The recurring defect class. `Number('') === 0`, `?? ''`, an empty
   array satisfying `every()`. Decide explicitly what nothing means.
5. **Mutation-test every assertion that matters.** Two mutations on PR 4 did *not* fail, and both
   times reporting that was the most useful thing in the report.
6. **A `BREAKING CHANGE:` footer is release-facing text.** Six on PR 4 needed correction, one
   because the controller asserted a false premise. Check every claim against the diff.
7. **A tool description is the LLM's only documentation.** `compare_periods` promised `null` and
   returned `''` for a year.
