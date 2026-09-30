CREATE TABLE agents_without_keys (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  owner_sub     TEXT NOT NULL REFERENCES carbon_units(sub),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

INSERT INTO agents_without_keys (id, workspace_id, owner_sub, created_at, revoked_at)
  SELECT id, workspace_id, owner_sub, created_at, revoked_at FROM agents;

DROP TABLE agents;
ALTER TABLE agents_without_keys RENAME TO agents;
CREATE INDEX agents_owner ON agents(owner_sub);
