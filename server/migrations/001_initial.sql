-- Run using the protected migration identity, never automatically on requests.
CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (
 id uuid PRIMARY KEY, discord_id text UNIQUE NOT NULL CHECK (discord_id ~ '^[0-9]{5,30}$'),
 display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
 role text NOT NULL DEFAULT 'contributor' CHECK (role IN ('contributor','moderator','admin')),
 version integer NOT NULL DEFAULT 1, disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_states (state_hash text PRIMARY KEY, binding_hash text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE guide_revisions (
 guide_id text NOT NULL CHECK (guide_id ~ '^[a-z0-9][a-z0-9-]{0,100}$'), revision integer NOT NULL CHECK (revision > 0),
 document jsonb NOT NULL, content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 publication_id uuid, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (guide_id,revision)
);
CREATE TABLE guides (
 id text PRIMARY KEY, revision integer NOT NULL, category text NOT NULL, summary text NOT NULL,
 FOREIGN KEY (id,revision) REFERENCES guide_revisions(guide_id,revision)
);
CREATE TABLE drafts (
 owner_id uuid NOT NULL REFERENCES users(id), guide_id text NOT NULL REFERENCES guides(id),
 version integer NOT NULL CHECK (version > 0), base_revision integer NOT NULL,
 document jsonb NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,guide_id),
 FOREIGN KEY (guide_id,base_revision) REFERENCES guide_revisions(guide_id,revision)
);
CREATE TABLE draft_history (
 owner_id uuid NOT NULL REFERENCES users(id), guide_id text NOT NULL REFERENCES guides(id),
 version integer NOT NULL, base_revision integer NOT NULL, document jsonb NOT NULL,
 content_hash text NOT NULL, saved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,guide_id,version)
);
CREATE TABLE submissions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), guide_id text NOT NULL REFERENCES guides(id),
 draft_version integer NOT NULL, base_revision integer NOT NULL, baseline_hash text NOT NULL,
 baseline_document jsonb NOT NULL, document jsonb NOT NULL, content_hash text NOT NULL,
 summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000), created_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','rejected','publishing','published')),
 reviewer_id uuid REFERENCES users(id), review_note text, reviewed_at timestamptz,
 UNIQUE(owner_id,guide_id,draft_version), FOREIGN KEY(guide_id,base_revision) REFERENCES guide_revisions(guide_id,revision)
);
CREATE INDEX submission_queue ON submissions(status,created_at);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
 subject_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_jobs (
 submission_id uuid PRIMARY KEY REFERENCES submissions(id), state text NOT NULL DEFAULT 'queued'
 CHECK (state IN ('queued','working','retry','awaiting_merge','awaiting_deployment','blocked','published')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, provider jsonb NOT NULL DEFAULT '{}', last_error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_due ON publication_jobs(state,available_at);
CREATE TABLE webhook_deliveries (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION prevent_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit history is append-only'; END $$;
CREATE TRIGGER draft_history_immutable BEFORE UPDATE OR DELETE ON draft_history FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON guide_revisions FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE FUNCTION preserve_submission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.guide_id IS DISTINCT FROM OLD.guide_id
 OR NEW.draft_version IS DISTINCT FROM OLD.draft_version OR NEW.base_revision IS DISTINCT FROM OLD.base_revision
 OR NEW.baseline_hash IS DISTINCT FROM OLD.baseline_hash OR NEW.baseline_document IS DISTINCT FROM OLD.baseline_document
 OR NEW.document IS DISTINCT FROM OLD.document OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
 RAISE EXCEPTION 'Submission snapshots are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION preserve_submission_snapshot();
CREATE TRIGGER snapshots_not_deleted BEFORE DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
INSERT INTO schema_migrations(version) VALUES(1);
