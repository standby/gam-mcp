# Lessons — gam-mcp 0.6.0 programme

Patterns worth not repeating. Written after PR 4, which ran nine tasks through
implementer + reviewer subagents with a controller (me) holding the plan.

## The controller's own instructions were wrong four times

Every one was caught by someone else. This is the highest-value pattern here: a brief
is not evidence, and an implementer that tests its premises is worth more than one
that obeys them.

1. **Task 3** — I asserted a symmetric test case would still cover a base-period
   mutation. It does not: with a duplicate on both sides, the surviving check satisfies
   it. The implementer mutation-tested my claim, found it false, and added a mirror case.
2. **Task 9** — I said no tool-level test covered `ctx.timezone != ctx.reportTimeZone`.
   `tests/report-zones.test.ts:45` already did. I had inherited the claim from PR 3's
   ledger and carried it into the plan unchecked.
3. **Tasks 8+9** — my sketched `listEnvelope(rows, summary, warnings, schema)` ordering
   would have broken two callers that pass `schema` positionally third. Tests are not
   typechecked in this repo, so it would have failed silently.
4. **Task 5 — the serious one.** I told an implementer that `drop_pp`/`drop_pct` were
   "internal variable names" and had them struck from a `BREAKING CHANGE:` footer. They
   were real JSON output fields that the branch deleted. I removed the footer's one
   accurate claim, and a factually wrong changelog entry would have shipped if the final
   whole-branch review had not caught it.

**Rule:** before asserting a fact in a dispatch brief, run the grep. When a brief states
a premise, tell the implementer to test it rather than assume it.

## Self-reports do not survive greps

Four PR 4 implementer reports made claims that failed checking — including one stating
`kv_report` was unaffected when it had a live regression, and one miscounting fixtures.
The code was usually fine; the reports were not.

**Rule:** treat a report as a claim. Verify the load-bearing ones yourself before
packaging the review, and name the unverified ones to the reviewer.

## `BREAKING CHANGE:` footers are release-facing text, not commentary

Six of PR 4's needed correction: one described an end state that had not arrived, one
omitted a silently dropped metric, one named internal variables as JSON fields, one was
missing entirely on a row-set narrowing. After a squash merge the PR body is the only
copy release-please sees.

**Rule:** check every claim in a footer against its own diff, every time. Consistency
inside one release beats a purist reading — if a sibling commit marks the same class of
change breaking, match it.

## A mutation that does not fail is the finding

Twice on PR 4 a mandated mutation left the suite green. Both times that was the most
useful line in the report: once it exposed that `fake-gam` ignores `dateRange`, so a
test could not distinguish base from previous period; once it showed a test passing for
the wrong reason.

**Rule:** require the mutation result, not the assertion count. "All tests pass" says
nothing about whether they can fail.

## Removing a helper is not removing its behaviour

Spec §1.4 said `numOr0` was removed. It was — and replaced with `num(x) ?? 0`, which is
byte-identical. Allowing that as a declared interim was right, but only because it was
pinned to a later task with a grep as the exit criterion and the final review was
pointed at the ledger line.

**Rule:** when you allow an interim, write the exit criterion as a command that must
print nothing, and name the task that owns it.

## Absence is not permission

The recurring defect class across this whole codebase. `Number('') === 0`; `?? ''`; an
empty array satisfying `every()`; a missing `status` passing an `ACTIVE` check; a
`stringValue: "true"` failing `=== true`. Sometimes the right answer *is* zero — §4.5
mandates it for an ad unit absent from a report — but it must be decided and commented,
never defaulted into.
