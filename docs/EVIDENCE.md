# Evidence

Run `npm run scenarios` with PostgreSQL running and the regular app stopped. The runner writes assertion-backed reports under `evidence/scenarios/`. Set `VAULT_EVIDENCE_DIR` to save a run separately.

| File | Contents |
| --- | --- |
| `run.json` | Start time, PostgreSQL version, and completed scenario list |
| `A.json` to `F.json` | HTTP submissions where applicable, durable reports, attempts, ordered timeline, and scenario-specific projection or retry information |
| `G.json` | Live report before termination, actual worker PID and SIGKILL, outstanding attempt after termination, expired heartbeat, and completed report with a deduplicated receipt |
| `screenshots/overview.png` | Delivery overview, evidence-backed activity and real event state |
| `screenshots/dead-letter.png` | Dead-letter detail, HTTP 503 attempts, schedules, and approval form |
| `screenshots/workers-mobile.png` | Responsive worker health view in Chromium |
| `logs/` | Actual command outputs collected by the verification workflow |

The GitHub **Verify** workflow uploads these files as `webhookvault-evidence`. It fails on mismatched outcomes, including when an intentionally failing fixture does not fail as expected. Screenshots come from Playwright while connected to the running production dashboard and API.

To independently inspect a report, compare the received, attempt, and terminal timestamps with its timeline. Compare the original receipt's commit timestamp with the final report in scenario G. The replacement worker's attempt must have a different worker ID and `deduplicated: true`.
