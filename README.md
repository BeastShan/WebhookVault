# WebhookVault

WebhookVault is a local laboratory for webhook delivery, durable recovery, and incident investigation. A Fastify API accepts signed synthetic events, a Node.js worker delivers them over loopback HTTP, and a separate receiver commits idempotent effects in PostgreSQL. A Next.js console reads delivery and worker state from the API.

## Run locally

Requires Node.js 24, npm, Docker with Compose, and available loopback ports 3000, 4310, 4311, and 55432.

```bash
npm ci
npm run local:setup
npm run db:up
npm run db:migrate
npm run dev
```

Open [the delivery console](http://127.0.0.1:3000). Start a second shell to send a signed synthetic event through the running application.

```bash
node --import tsx --input-type=module -e '
  import { client } from "./scripts/client.ts";
  import { sample } from "./scripts/lab.ts";
  console.log(await client("http://127.0.0.1:4310").send(sample("manual-delivery")));
'
```

Use `npm run build` followed by `npm start` for the production build of the local console and the same backend processes. A custom `VAULT_API_PORT` must be exported to both the build and runtime processes because Next.js compiles the proxy destination at build time.

The replay form requires the generated `VAULT_OPERATOR_TOKEN` from the untracked `.env`. The webhook signer and receiver have separate credentials. Keep the demo services on loopback.

## Reproduce and verify

Stop the application first. The scenarios and integration suite own their workers and share the local database between runs. Run these commands sequentially.

```bash
npm run scenarios
npm test
npm run test:integration
npm run typecheck
npm run build
npx playwright install chromium
npm run test:browser
```

On Linux machines without browser system libraries, install Chromium with `npx playwright install --with-deps chromium`. The scenarios preserve each run's event IDs in PostgreSQL. The Compose volume survives `npm run db:down`. To delete all demo data, explicitly run `docker compose down --volumes`.

## Local API

| Method and path | Behavior |
| --- | --- |
| `POST /webhooks/synthetic` | Authenticate exact JSON bytes and record a delivery |
| `GET /health` | Check PostgreSQL connectivity |
| `GET /api/dashboard` | Read totals, recent deliveries, the dead-letter queue, and heartbeats |
| `GET /api/deliveries/:id/report` | Read a delivery report and its timeline |
| `GET /api/deliveries/:id/export` | Download a redacted incident JSON report |
| `GET /api/deliveries/:id/investigation` | Export a scoped task for a failed delivery at a pinned revision |
| `GET /api/task-schema` | Read the provider-independent JSON Schema |
| `POST /api/events/:id/replay` | Approve one redrive with a bearer token, `approved: true`, and an audit reason |

See [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), [Failure scenarios](docs/FAILURE_SCENARIOS.md), [Replay safety](docs/REPLAY_SAFETY.md), and [Evidence](docs/EVIDENCE.md). The future agent workflow is covered in [Devin integration](docs/DEVIN_INTEGRATION.md), [Agent prompts](docs/DEVIN_AGENT_PROMPT.md), and the [30-day roadmap](docs/ROADMAP.md). [Limitations](docs/LIMITATIONS.md) describes current operational boundaries.

## Versions

The npm registry releases and Fastify plugin compatibility were checked on 2026-11-22 before implementation. Node.js 24 runs the project. Direct dependencies are pinned in `package.json` and the full graph in `package-lock.json`.

| Component | Verified release |
| --- | --- |
| PostgreSQL Docker image | 18.4 |
| Fastify / rate limit | 5.12.8 / 11.3.0 |
| PostgreSQL driver | 8.23.1 |
| Next.js / React | 16.4.6 / 19.3.1 |
| TypeScript / Zod | 7.0.2 / 4.6.7 |
| Vitest / Playwright | 5.1.1 / 1.65.1 |

MIT License. See [LICENSE](LICENSE).
