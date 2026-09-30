ALTER TABLE carbon_units ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE carbon_units ADD COLUMN last_verified_at INTEGER;
ALTER TABLE carbon_units ADD COLUMN headless_suspended_at INTEGER;

CREATE TABLE headless_keys (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id),
  label            TEXT NOT NULL,
  suggested_name   TEXT NOT NULL,
  key_hash         TEXT NOT NULL UNIQUE,
  key_hint         TEXT NOT NULL,
  sponsor_sub      TEXT NOT NULL REFERENCES carbon_units(sub),
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  last_used_at     INTEGER,
  revoked_at       INTEGER,
  rotated_from     TEXT REFERENCES headless_keys(id)
);
CREATE INDEX headless_keys_workspace ON headless_keys(workspace_id);
