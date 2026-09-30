CREATE UNIQUE INDEX headless_keys_rotated_from ON headless_keys(rotated_from);
CREATE INDEX headless_keys_workspace_created ON headless_keys(workspace_id, created_at DESC, id DESC);
