# Limitations

- The ordering rule applies to versioned snapshots. It permits sequence gaps and does not implement contiguous streams, buffering, or reconciliation from provider APIs.
- Receiver-side idempotency depends on a transactionally stored receipt and a PostgreSQL business effect. An external HTTP endpoint would need its own idempotency contract and reconciliation for ambiguous responses.
- The lab uses one source, one receiver, shared local operator credentials, in-process rate limiting, and a fixed replay limit. It has no tenant isolation, TLS termination, credential rotation, or distributed operator authorization. Loopback alone does not isolate other processes on the same host.
- PostgreSQL is a single instance. The bootstrap migration is intended for fresh development databases. There is no rolling migration framework, retention job, backup verification, or high availability.
- Recent delivery and dead-letter views each show up to 150 records. Reports can include the complete duplicate history for a single event. There is no pagination or archival policy.
- The API records accepted-size requests that reach the JSON ingress handler. Transport failures, requests rejected before parsing, throttled requests and unsupported content types have no incident row.
- Browser state polls every three seconds. Heartbeats are a best-effort health indicator and long processing may outlast the five-second display threshold. There is no metrics pipeline or alerting.
- Incident exports contain synthetic IDs and digests. Provider integrations require a field-by-field privacy review and policies for redaction, retention, and access.
- The live Devin adapter is disabled. Task export pins a revision and packages existing evidence but does not provision an environment or dispatch work.
