# Replay safety

1. Open an accepted delivery in the dead-letter queue and inspect the original attempts and failure details.
2. Enter the local operator token and a reason. Select **I approve this replay** and submit.
3. Inspect the replay execution separately. The original job, signed timestamp, delivery records, and attempt history remain intact.

The API authenticates the operator and validates the literal approval value and reason. The event must have an original job in `dead_letter`. The database permits one replay approval per event and grants it atomically with the new job. Parallel requests contend for the same replay slot. A successful replay and a replay that reaches its limit both consume that slot.

Replay has at most two attempts. It uses the same source, provider ID, event ID, validated payload projection and receiver. An existing receipt is reused. If the source stream advanced before replay, the conditional sequence rule prevents an older or equal snapshot from overwriting it. There is no API option to reset the replay budget or edit the input.

The audit reason is persisted under the generated local operator identity. Export surfaces include the approval timestamp and audit ID. The reason remains in PostgreSQL for a privileged local audit.
