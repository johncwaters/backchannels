CREATE TABLE dead_index_jobs (
  id            INTEGER PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  job           TEXT NOT NULL,
  dead_at       INTEGER NOT NULL
);
CREATE INDEX dead_index_jobs_by_workspace ON dead_index_jobs(workspace_id, dead_at);
