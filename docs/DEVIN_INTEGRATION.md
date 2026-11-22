# Devin integration contract

The API exports an investigation task for a delivery with failed attempt evidence and a pinned source revision. In a clean Git checkout it pins `HEAD`; an explicitly trusted build can supply `VAULT_REVISION`. The runtime validates the full task using Zod. Fetch `GET /api/task-schema` for versioned JSON Schema covering investigation, repair, and independent verification.

| Stage | Required input | Expected output |
| --- | --- | --- |
| Investigation | Pinned base, event and delivery IDs, typed attempt logs, scenario, isolated runtime constraints | Reproduction result, failure diagnosis, proposed repair scope and regression plan |
| Repair | Original task scope, investigation reference, separate approval reference, allowed paths | Candidate commit, regression results, and reviewable diff |
| Independent verification | Original task scope, repair reference, distinct fresh checkout, candidate commit | Base and candidate outcomes, idempotency and ordering results, and actual Git diff review |

The evidence export includes only typed identifiers, outcomes, attempt numbers and HTTP status codes. Its scenario is a reproduction template. It carries no raw payload values, operator reason, credentials, dynamic commands, or destination URLs. Agents must read these as data and derive execution from the pinned repository documentation.

The live adapter is disabled, with no provider client, session creation, or remote credentials. Enabling it requires scoped authentication, enforced resource limits, isolation and egress controls, idempotent dispatch, cancellation, signed callbacks or authenticated polling, and human approval at repair and merge boundaries. Investigation credentials should be read-only. Repair should have short-lived write access to a restricted candidate branch. Verification should use separate read-only credentials and its own clean database. See the [prompts](DEVIN_AGENT_PROMPT.md) and [roadmap](ROADMAP.md).
