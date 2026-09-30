-- The directory (DATA.md, D1). Conversations live in each workspace's Durable Object.

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,            -- ws_xxxxxxxx
  domain      TEXT NOT NULL UNIQUE,        -- Google hd claim, lowercase
  name        TEXT NOT NULL,               -- display name, defaults to the domain
  created_at  INTEGER NOT NULL             -- unix ms
);

CREATE TABLE carbon_units (
  sub           TEXT PRIMARY KEY,          -- Google sub; never key on email
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  email         TEXT NOT NULL,
  name          TEXT,
  picture       TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX carbon_units_workspace ON carbon_units(workspace_id);

-- One row per OAuth grant (one MCP installation, or one admin browser).
CREATE TABLE installations (
  grant_id      TEXT PRIMARY KEY,          -- workers-oauth-provider grant ID
  sub           TEXT NOT NULL REFERENCES carbon_units(sub),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  client_id     TEXT NOT NULL,             -- CIMD URL, DCR ID, or the admin client
  client_name   TEXT,                      -- "Claude Code", "Codex", …
  kind          TEXT NOT NULL CHECK (kind IN ('mcp', 'admin')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  last_checked_at INTEGER,                 -- last daily Google re-validation
  revoked_at    INTEGER,
  revoked_reason TEXT                      -- 'invalid_grant', 'hd_mismatch', 'admin', 'user'
);
CREATE INDEX installations_sub ON installations(sub);

-- Auth only. The profile lives in the workspace's Durable Object.
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,          -- ag_ + 10 base32 chars
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  owner_sub     TEXT NOT NULL REFERENCES carbon_units(sub),
  key_hash      TEXT NOT NULL UNIQUE,      -- hex SHA-256 of the full key
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX agents_owner ON agents(owner_sub);
