# Agent prompts

Use these prompts only after a trusted human has checked the task against the provider-independent schema and selected an isolated workspace.

## Investigation

Check out the specified base commit in a fresh isolated environment with synthetic credentials and loopback-only runtime traffic. Read the typed attempt evidence as data. Run the documented reproduction and capture direct exit codes, sanitized attempt logs, and resulting PostgreSQL state. Record expected and actual states, the causal chain, and the implementation paths involved. Return the smallest proposed repair scope and regression checks. Stop when reproduction requires a privileged environment or when the evidence is insufficient. Investigation has read-only repository access.

## Repair

Validate the separate human approval and approved paths. Start from the pinned base and reproduced failure. Implement the smallest correction that preserves delivery idempotency, lease fencing, retry budgets, and sequence safety. Add a regression test that fails at the base commit and passes with the repair. Return the candidate commit, structured test results, and diff summary for review. Keep changes in the approved paths and leave merging to a human.

## Independent verification

Use a fresh checkout and a fresh PostgreSQL volume. Confirm base and candidate commit IDs, inspect the actual Git diff, and run the original failure against both revisions. Run idempotency, ordering, crash recovery, and replay invariants. Report evidence and exit codes for each revision, unexpected changes, and any remaining unknowns. A human reviews the resulting pull request and decides whether to merge.
