-- Operator-only additive migration. Historical documents and receipts are unchanged.
ALTER TABLE guides ADD COLUMN publication_pin jsonb CHECK (publication_pin IS NULL OR jsonb_typeof(publication_pin)='object');
ALTER TABLE guides ADD COLUMN publication_target jsonb CHECK (publication_target IS NULL OR jsonb_typeof(publication_target)='object');
ALTER TABLE submissions ADD COLUMN publication_target jsonb CHECK (publication_target IS NULL OR jsonb_typeof(publication_target)='object');
CREATE TABLE publication_migration_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), legacy_target jsonb NOT NULL CHECK(jsonb_typeof(legacy_target)='object')
);
CREATE TABLE guide_publication_authority (
 guide_id text PRIMARY KEY REFERENCES guides(id), target jsonb NOT NULL CHECK(jsonb_typeof(target)='object'),
 canonical_revision integer NOT NULL CHECK(canonical_revision>0), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 content_commit text CHECK(content_commit ~ '^[a-f0-9]{40}$'), version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE publication_pin_controllers (
 origin text PRIMARY KEY CHECK(origin ~ '^[a-z0-9][a-z0-9._-]{0,80}$'), version integer NOT NULL DEFAULT 0,
 content_commit text CHECK(content_commit ~ '^[a-f0-9]{40}$'), app_commit text CHECK(app_commit ~ '^[a-f0-9]{40}$'),
 provider jsonb NOT NULL DEFAULT '{}', lease_token uuid, lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
DECLARE configured text := current_setting('pvme.legacy_publication_target',true); destination jsonb;
BEGIN
 IF configured IS NOT NULL AND configured <> '' THEN
  destination := configured::jsonb;
  IF destination->>'pipeline' <> 'legacy-v1' THEN RAISE EXCEPTION 'Migration requires the original legacy target'; END IF;
  INSERT INTO publication_migration_settings(singleton,legacy_target) VALUES(true,destination);
  UPDATE submissions SET publication_target=destination;
  UPDATE guides SET publication_target=destination;
  INSERT INTO guide_publication_authority(guide_id,target,canonical_revision,content_hash)
   SELECT g.id,destination,g.revision,r.content_hash FROM guides g JOIN guide_revisions r ON r.guide_id=g.id AND r.revision=g.revision;
 ELSE
  RAISE EXCEPTION 'Explicit original legacy publication target required before applying publication routing';
 END IF;
END $$;
CREATE FUNCTION sync_guide_publication_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE guides SET publication_target=NEW.target,publication_pin=(SELECT jsonb_build_object('contentCommit',content_commit,'version',version) FROM publication_pin_controllers WHERE origin=NEW.target->>'origin') WHERE id=NEW.guide_id;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_publication_authority_sync AFTER INSERT OR UPDATE ON guide_publication_authority FOR EACH ROW EXECUTE FUNCTION sync_guide_publication_authority();
CREATE FUNCTION protect_guide_publication_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.publication_target IS DISTINCT FROM OLD.publication_target AND NOT EXISTS(SELECT 1 FROM guide_publication_authority WHERE guide_id=NEW.id AND target=NEW.publication_target) THEN
  RAISE EXCEPTION 'Guide publication destination requires an explicit authority handoff';
 END IF;
 IF NEW.publication_pin IS DISTINCT FROM OLD.publication_pin AND NEW.publication_pin IS DISTINCT FROM (SELECT jsonb_build_object('contentCommit',p.content_commit,'version',p.version) FROM publication_pin_controllers p WHERE p.origin=NEW.publication_target->>'origin') THEN
  RAISE EXCEPTION 'Guide content pin must match its durable controller';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_publication_target_guard BEFORE UPDATE ON guides FOR EACH ROW EXECUTE FUNCTION protect_guide_publication_authority();
CREATE FUNCTION sync_publication_pin_controller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE guides g SET publication_pin=jsonb_build_object('contentCommit',NEW.content_commit,'version',NEW.version)
  FROM guide_publication_authority a WHERE a.guide_id=g.id AND a.target->>'pipeline'='content-pin-v1' AND a.target->>'origin'=NEW.origin;
 RETURN NEW;
END $$;
CREATE TRIGGER publication_pin_controller_insert_sync AFTER INSERT ON publication_pin_controllers FOR EACH ROW EXECUTE FUNCTION sync_publication_pin_controller();
CREATE TRIGGER publication_pin_controller_update_sync AFTER UPDATE ON publication_pin_controllers FOR EACH ROW WHEN (NEW.content_commit IS DISTINCT FROM OLD.content_commit OR NEW.version IS DISTINCT FROM OLD.version) EXECUTE FUNCTION sync_publication_pin_controller();
CREATE FUNCTION bind_submission_publication_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.publication_target IS NULL THEN SELECT legacy_target INTO NEW.publication_target FROM publication_migration_settings WHERE singleton=true; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_legacy_publication_target BEFORE INSERT ON submissions FOR EACH ROW EXECUTE FUNCTION bind_submission_publication_target();
CREATE FUNCTION protect_submission_publication_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.publication_target IS DISTINCT FROM OLD.publication_target THEN RAISE EXCEPTION 'Submission publication destination is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER submission_publication_target_immutable BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION protect_submission_publication_target();
CREATE TRIGGER publication_migration_settings_immutable BEFORE UPDATE OR DELETE ON publication_migration_settings FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
INSERT INTO schema_migrations(version) VALUES(2);
