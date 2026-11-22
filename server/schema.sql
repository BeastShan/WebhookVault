CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  provider_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_at timestamptz NOT NULL,
  payload_hash text NOT NULL,
  stream text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  value integer NOT NULL,
  fault text NOT NULL CHECK (fault IN ('none', 'transient', 'permanent')),
  UNIQUE (source, provider_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id uuid PRIMARY KEY,
  event_id uuid REFERENCES events,
  source text NOT NULL,
  provider_id text,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_at timestamptz,
  payload_hash text NOT NULL,
  signature text NOT NULL CHECK (signature IN ('verified', 'rejected')),
  disposition text NOT NULL CHECK (disposition IN ('accepted', 'duplicate', 'conflict', 'invalid_signature', 'stale_timestamp', 'invalid_payload'))
);
CREATE INDEX IF NOT EXISTS deliveries_event_idx ON deliveries (event_id, received_at);
CREATE INDEX IF NOT EXISTS deliveries_recent_idx ON deliveries (received_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS replays (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE REFERENCES events,
  approved_by text NOT NULL,
  reason text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events,
  replay_id uuid UNIQUE REFERENCES replays,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'retry', 'succeeded', 'ignored', 'dead_letter')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  lease_until timestamptz,
  lease_token uuid,
  finished_at timestamptz,
  detail text
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_original_idx ON jobs (event_id) WHERE replay_id IS NULL;
CREATE INDEX IF NOT EXISTS jobs_event_idx ON jobs (event_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (available_at, id) WHERE state IN ('queued', 'retry');
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_until) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS attempts (
  job_id uuid NOT NULL REFERENCES jobs,
  number integer NOT NULL,
  worker_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'applied', 'stale', 'retryable', 'lease_expired', 'reconciled')),
  detail text,
  http_status integer,
  deduplicated boolean NOT NULL DEFAULT false,
  next_at timestamptz,
  PRIMARY KEY (job_id, number)
);

CREATE TABLE IF NOT EXISTS projections (
  source text NOT NULL,
  stream text NOT NULL,
  sequence integer NOT NULL,
  value integer NOT NULL,
  PRIMARY KEY (source, stream)
);

CREATE TABLE IF NOT EXISTS receipts (
  event_id uuid PRIMARY KEY REFERENCES events,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'stale')),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS receiver_failures (
  event_id uuid NOT NULL REFERENCES events,
  job_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail text NOT NULL,
  PRIMARY KEY (job_id, attempt_number),
  FOREIGN KEY (job_id, attempt_number) REFERENCES attempts (job_id, number)
);

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz
);
