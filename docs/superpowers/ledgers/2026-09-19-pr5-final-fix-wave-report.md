# PR 5 final fix wave — report

Worktree: `~/workspace/gam_mcp-0.6.0-pr5`, branch `feat/0.6.0-docs-release`.
Base before this wave: `a03d9ac`. Nine commits added, nothing pushed.

**Addendum (post-review):** the coordinator caught a self-inflicted bug in
`fcf3f14`'s commit *message*: it quoted "BREAKING CHANGE:" at the start of a
wrapped line while explaining the extraction command, which made the
extraction command (and the naive per-commit `grep`) count 19 footers instead
of 18 — the 19th being `fcf3f14` itself, once it existed in `main..HEAD`. This
was invisible when I first verified the command, because I ran it *before*
committing `fcf3f14`. Fixed by amending `fcf3f14`'s message only (tree
unchanged) via `git commit-tree` + `git rebase --onto` (no `-i`), which
necessarily rewrote the three commits stacked on top of it. See "Post-amend
re-verification" at the end of this report for the new SHAs and the counts
produced by actually re-running both commands afterward.

## Commit split

One commit per finding, except I-1/M-3 which the task itself scoped as one edit
("While you are in that paragraph (M-3)"):

1. `22d5748` docs(readme): name the four tools that cannot be pinned to a fixed window (I-1 + M-3)
2. `b3e00e5` docs(readme): note health_check's isError failure path (M-4)
3. `0994efb` docs(release-notes): cover both reasons an entry is footerless-section material (M-6)
4. `88a6aee` docs(release-notes): correct the .strict() schema count (M-1)
5. `e72b38c` docs(release-notes): GAM_PAGE_ROWS stops startup in stdio too (I-2)
6. `fcf3f14` → amended to `d662416` docs(release-notes): the squash-merge instruction now yields all 18 footers (I-3)
7. `cf547da` → rebased to `00c8be4` docs(spec): describe_line_item's sensitive fields match the code (M-2)
8. `a56c79b` → rebased to `dc6a8c2` docs: replace CLAUDE.md's stale sections with the real commands and architecture (I-4)
9. `88cfb02` → rebased to `48fadb6` test: scrub a case-sensitive miss of the publisher's real placement name (I-5)

(SHAs 7–9 changed only because commit 6's parent was rewritten; their trees
and messages are byte-identical to the originals — verified below.)

Reasoning for the split: each finding touches a distinct claim/concern, even where
two findings share a file (README, release notes). I-1 and M-3 are the same
paragraph and the task frames M-3 as incidental to doing I-1's edit, so they're one
commit. M-4 is a different paragraph, a different claim (health_check semantics),
so it's separate. The four release-notes findings (M-6, M-1, I-2, I-3) are four
non-overlapping hunks in one file, each independently verified against source, so
each got its own commit for a clean audit trail against the review's finding IDs.

## I-1 (blocking) + M-3 — README Reliability paragraph

New sentence naming all four tools (replacing the old paragraph in
`README.md`, §Reliability):

> **Four tools cannot be pinned to a fixed window at all:** `find_unused_ad_units`,
> `diagnose_fill_rate`, and `diagnose_floor_pricing` take only `lookback_days` (no
> `date_range` field in their input), and `find_anomalies` takes no window input
> whatsoever — it always uses a hardcoded 7-day lookback. Calling any of those four
> on a recurring schedule (e.g. a daily cron) defines one new hidden report per
> tool, every day, forever.

Verified from source directly (not copied from spec/release-notes without
checking): `src/tools/find_unused_ad_units.ts` (`lookback_days` default 30, no
`date_range`), `src/tools/diagnose_fill_rate.ts` and
`src/tools/diagnose_floor_pricing.ts` (`lookback_days` default 7, no `date_range`),
`src/tools/find_anomalies.ts` (no window field in its `.strict()` schema at all;
`lastDays(7, ctx.timezone, ctx.now)` hardcoded twice). `src/report-key.ts`'s
`canonicalDefinition()` never strips `dateRange`, confirming it's part of the hash.

M-3 fix: the paragraph now states "dimensions, metrics, filters, sort, **and the
resolved date range**" as part of the hash in its first sentence, rather than
making the bounded-by-shapes claim first and correcting it in the next sentence.

## I-2 — release notes vs. GAM_PAGE_ROWS scope

Confirmed in `src/cli.ts:36-37`: `resolvePageRows(...)` and `stop()` run
unconditionally, before the `if (http === null)` branch at line 38. Dropped
`GAM_PAGE_ROWS` from the "(HTTP mode adds more: ...)" parenthetical in the
release notes and added a sentence explaining it's checked before the mode
branch, so a bad value exits 2 in stdio too — matching `README.md:62` and `:225`,
which were already correct.

## I-3 (blocking) — squash-merge instruction

Old instruction pointed at a section that names only 2 of 18 footer-carrying
commits by design. Replaced with an extraction command, run and verified before
writing it down:

```
git log main..HEAD --format='@@@%H%n%B' | awk '
  /^@@@/ { sha=substr($0,4); p=0; next }
  /^BREAKING CHANGE:/ { p=1; if (!printed[sha]) { print "--- " sha " ---"; printed[sha]=1 } }
  p { if ($0 == "") { p=0 } else print }
'
```

Output at the time this commit was first written: 18 `--- <sha> ---` blocks, 18
full `BREAKING CHANGE:` paragraphs, none truncated (checked specifically
against commit `fff1731`'s 12-line footer, the longest one — a naive
`grep -A5` would have cut it to 5 lines). Cross-checked against
`git log main..HEAD --format=%B | grep -c '^BREAKING CHANGE:'` → also 18.

**This count was invalidated the moment the commit was created** — its own
message described the result using a line that itself started with
`BREAKING CHANGE:`, so once that commit existed in `main..HEAD`, both the
extraction command and the plain `grep -c` count started returning 19, not
18. The coordinator caught this; see the Addendum at the top and "Post-amend
re-verification" below for the fix and the counts re-run after amending.

## I-4 — CLAUDE.md

Added `## Commands` (from `package.json`'s `scripts`) and `## Architecture`
(GAM API flavor — REST, `src/gam-client-rest.ts`, `https://admanager.googleapis.com/v1`;
transport layer — stdio default, HTTP via `GAM_HTTP_PORT`, new `Server`/transport
per HTTP request; auth flow — `src/auth.ts`'s three credential sources plus
`withRetries()`'s GET/POST retry rules; tool registry pattern —
`ToolDefinition`/`buildReportTool()` in `src/report-tool-builder.ts`,
`src/tools/index.ts`'s `SHARED_TOOLS`/`SAVED_QUERY_TOOLS` split; the report path —
create → poll → page in `src/report-exec.ts`/`src/report-reuse.ts`, hidden/
undeletable reports, the four wall-clock tools; the cache — `src/cache.ts`'s
two-tier reference cache). Deleted "When this file is out of date," the only
section the file itself asked to be deleted. Kept Hard constraints, the
Generic-MCP principle, Design guidelines for tools, and Commit messages verbatim
— unchanged, per the task's explicit instruction that these are still binding.

## I-5 — case-sensitive sweep miss

`tests/report-definition.test.ts:58,63` had the placement name in lowercase in the
identical construct scrubbed from the README (replacement: `'Nimbus'`). Replaced
with `'nimbus'`.

Re-ran the sweep case-insensitively over all tracked files (excluding the two
frozen pre-0.6.0 docs, `docs/superpowers/plans/2026-04-30-gam-mcp.md` and
`docs/superpowers/specs/2026-04-30-gam-mcp-design.md`, both of which still
correctly carry the frozen `123456789` network code per the recorded ruling).
Full results:

- **the placement name (case-insensitive):** 2 more hits beyond the primary target, both
  in in-scope 0.6.0 planning docs (not frozen): `docs/superpowers/plans/2026-09-17-gam-mcp-0.6.0-pr2-identity-cache.md:169,174` (the same test construct, evidently copied into the plan) and `docs/superpowers/plans/2026-09-17-gam-mcp-0.6.0-pr3-inputs-http.md:4669` (a code comment example). Fixed all three files, replacing the placement name in both cases with `'nimbus'`/`'Nimbus'` consistently.
- **the market name (both spellings):** zero hits anywhere in tracked files.
- **`los angeles` / `los_angeles`:** hits only as a generic IANA timezone value
  (`'America/Los_Angeles'`) used as a test fixture across ~20 unrelated test
  files (`tests/zones.test.ts`, `tests/tools/*.test.ts`, etc.) — not presented as
  publisher configuration anywhere, unlike the README's original quickstart
  example. Left alone; flagged in the commit message as considered-and-rejected.
- **Currency codes:** only `USD`/`EUR` appear as 3-letter tokens beyond acronyms
  (GAM, API, MCP, SDK, etc.); no currency code tied to the original
  scrubbed market.
- **Network-code-shaped numbers (8–10 digits):** only test-fixture IDs
  (`11002726`, `11002727`, custom targeting key IDs paired with generic names
  `main_category_id`/`section`) and unrelated numeric literals (dates, a commit
  hash substring, `Number.MAX_SAFE_INTEGER`-adjacent test boundaries). No
  additional real-looking network code found outside the two frozen docs.

## Verification

- `npm run typecheck` — clean.
- `npm test` — 985/985 passed, 79 test files (matches the required count).
- `npm run build` — clean.
- `npm run verify:pack` — PASS (env-less mode: exit 2 with documented error, packaging mechanics verified).
- Attribution check: `git log 0ea54e7..HEAD --format='%B' | grep -i -E '^(co-authored-by|.*generated with \[?claude|claude-session)'` → no output.
- Control-byte scan (Python, byte < 32 excluding tab/LF/CR) on every changed file → 0 bad bytes in each.
- `git status --short` → clean working tree after the 9 commits.

## Concerns / notes for the reviewer

- No BREAKING CHANGE footers were added anywhere — this wave is documentation plus one test fixture, per the task's own instruction.
- The squash-merge extraction command depends on `main` still being an ancestor-diverged ref reachable as `main..HEAD` at merge time; if the branch is rebased or `main` moves before merge, re-run it rather than trusting stale output.
- `package.json`'s version is still `0.5.2`; version bump is out of this wave's scope (release-please's job) and was left untouched.

## Post-amend re-verification (in response to the coordinator's follow-up)

**The bug:** `fcf3f14`'s own commit message described the verification I'd run,
and one wrapped line in that description started with the literal text
`BREAKING CHANGE:` (unadorned, at column 0). Both `grep -c '^BREAKING CHANGE:'`
and the documented `awk` extraction command match on `^BREAKING CHANGE:`
against every commit body in `main..HEAD` — including, once it existed,
`fcf3f14` itself. So the moment that commit was created, both counts became
19, not 18. My original verification (18/18) was real but stale: it was run
*before* `fcf3f14` existed, so it couldn't see the commit it was about to
create.

**Root cause class checked across the whole wave:** grepped all nine original
commit messages for `^BREAKING CHANGE:` (line-start, case-sensitive). Only
`fcf3f14` had it. The other eight discuss breaking changes only in
lowercase/mid-line prose (e.g. "a bad `GAM_PAGE_ROWS`... breaking changes the
release notes list") or reference the token mid-sentence inside quotes, never
as the first four bytes of a line.

**Fix:** left `fcf3f14`'s tree (the file diff) untouched — only the commit
message changed, rewording the offending line so `BREAKING CHANGE:` never
starts a line (it now reads "...paragraphs opening with the `` `BREAKING
CHANGE:` `` token, matching a plain `` `grep -c '^BREAKING CHANGE:'` ``
count..." — backtick-quoted and never at column 0). Applied via
`git commit-tree fcf3f14^{tree} -p e72b38c -F <new message>` to produce a new
commit with an identical tree, then `git rebase --onto <new-commit> fcf3f14
feat/0.6.0-docs-release` (no `-i`) to replay the three commits stacked on top.
Verified before deleting the temporary backup branch that all three replayed
commits have trees and messages byte-identical to the originals — only their
SHAs (and parent chain) changed, as expected.

**New SHAs** (old → new): `fcf3f14` → `d662416`, `cf547da` → `00c8be4`,
`a56c79b` → `dc6a8c2`, `88cfb02` → `48fadb6`. Unaffected commits (`22d5748`,
`b3e00e5`, `0994efb`, `88a6aee`, `e72b38c`) kept their original SHAs.

**Counts, re-run just now, after the amend:**

- Coordinator's per-commit loop (`for c in $(git rev-list main..HEAD); do git
  log -1 --format=%B $c | grep -q '^BREAKING CHANGE:' && echo x; done | wc -l`)
  → **18**.
- The documented extraction command, extracted verbatim from
  `docs/superpowers/RELEASE-NOTES-0.6.0.md` (not retyped) and executed →
  **18** `--- <sha> ---` blocks and **18** `BREAKING CHANGE:` paragraphs.

**Full re-verification after the amend:**

- `npm run typecheck` — clean.
- `npm test` — 985/985 passed, 79 test files.
- `npm run build` — clean.
- `npm run verify:pack` — PASS.
- Attribution check (`git log 0ea54e7..HEAD --format='%B' | grep -i -E
  '^(co-authored-by|.*generated with \[?claude|claude-session)'`) — no output,
  re-run against the rewritten range.
- Control-byte scan on every changed file's working-tree content — 0 bad bytes
  in each, re-run after the amend.
- Control-byte scan on all nine commit *messages* in the rewritten range
  (bytes < 32 excluding tab/newline) — 0 bad bytes in each, including the two
  new SHAs.
- `git status --short` — clean working tree; temporary `backup-before-amend`
  branch deleted after the rebase was confirmed correct.

**Confirmation:** no other commit message in the wave has the same problem —
checked before and after the amend, by grepping all nine messages in the
final range for lines starting with `^BREAKING CHANGE:`; only the original
`fcf3f14` ever matched, and it no longer does.
