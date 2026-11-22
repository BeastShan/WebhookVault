# 30-day Devin integration roadmap

Target effort is **22 engineer-days** over 30 calendar days for one backend engineer with platform and security review. Provider sandbox and credential access are dependencies.

| Days | Work and estimate | Acceptance criteria |
| --- | --- | --- |
| 1–5 | Threat model, provider capability review, versioned output schemas, 4 days | Review access boundaries, test positive and negative fixtures for all three phases, and record provider capability gaps |
| 6–12 | Durable task state, credential broker, idempotent dispatch, 5 days | Repeated submissions create one provider job; scoped credentials expire and cannot access unrelated repositories |
| 13–19 | Budget, signed status updates, cancellation, sandbox enforcement, 5 days | Enforce default limits of one active task and 30 minutes per task, prove forbidden egress is blocked, and disallow follow-on dispatch after cancellation |
| 20–25 | Separate repair approval and clean verification, 5 days | Missing or invalid approval blocks every repair attempt; verification independently reproduces a pinned failure and compares the actual diff and invariant results |
| 26–30 | Controlled pilot, documentation, and security review, 3 days | Complete three authorized synthetic pilots, review evidence on each resulting PR, and test the adapter disable switch before considering wider use |

The public tracking issue should use the title **Implement secure Devin task dispatch and independent verification** and link back to this roadmap. Pilot success requires a human review and sign-off on security controls before enabling the adapter.
