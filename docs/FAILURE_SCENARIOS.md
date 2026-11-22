# Failure scenarios

With isolated PostgreSQL running and the regular app stopped, execute `npm run scenarios` or select a case with `npm run scenarios -- G`. The harness starts real HTTP services and a Node worker. A failed assertion exits nonzero, including cases where a deliberately failing event succeeds unexpectedly.

| Case | Stimulus | Required durable evidence |
| --- | --- | --- |
| A | Submit one valid signed snapshot | HTTP 202, one attempt, one applied receipt and projection |
| B | Submit eight concurrent requests with the same provider ID and body | One accepted, seven duplicate deliveries, one job attempt and one effect |
| C | Append whitespace to signed raw bytes | HTTP 401, rejected delivery digest, no event or attempt |
| D | Receiver returns HTTP 503 twice | Two persisted failure records, scheduled bounded backoff, then HTTP 200 and an applied receipt |
| E | Receiver always returns HTTP 503 | Three persisted failures, terminal dead letter, no next retry or applied effect |
| F | Send sequence 2, then sequence 1 and another sequence 2 | The latter two are stale and the projection remains sequence 2 with its original value |
| G | Wait for a committed receiver receipt while the worker is still awaiting acknowledgement, then SIGKILL it | Running state survives the process, heartbeat expires, replacement worker records an expired lease and then reuses the original receipt |

The integration suite verifies replay separately. A permanently failing original has three attempts and its approved redrive has at most two. With a two-attempt original budget, the transient receiver enters dead letter, then the explicitly approved redrive succeeds while preserving the failed original execution.
