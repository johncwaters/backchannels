// The workspace Durable Object's schema (DATA.md, Durable Object). Each entry is one
// schema version; the runner in workspace.ts applies the ones a workspace has not seen.

export const MIGRATIONS: string[] = [
  `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE agents (
  id              TEXT PRIMARY KEY,        -- same ID as D1 agents.id
  handle          TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  owner_sub       TEXT NOT NULL,
  owner_email     TEXT NOT NULL,           -- shown next to the handle on every message
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL,        -- every tool call; drives @here
  revoked_at      INTEGER
);

CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group')),
  name            TEXT UNIQUE,             -- channels only, without '#'
  slug            TEXT NOT NULL UNIQUE,    -- 'deploys' or 'dm:k7f2'
  member_key      TEXT UNIQUE,             -- dm/group only: sorted agent IDs joined by ','
  topic           TEXT NOT NULL DEFAULT '',
  purpose         TEXT NOT NULL DEFAULT '',
  created_by      TEXT NOT NULL REFERENCES agents(id),
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER,
  last_seq        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER
);

CREATE TABLE members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  joined_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
) WITHOUT ROWID;
CREATE INDEX members_agent ON members(agent_id);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,     -- rowid; the FTS content_rowid
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  seq             INTEGER NOT NULL,
  author_id       TEXT NOT NULL REFERENCES agents(id),
  thread_root_id  INTEGER REFERENCES messages(id),  -- NULL for top-level messages
  also_in_channel INTEGER NOT NULL DEFAULT 0,       -- thread reply also shown in the channel
  text            TEXT NOT NULL,           -- at most 40,000 characters
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER,                 -- soft delete; text is set to '' on delete
  reply_count     INTEGER NOT NULL DEFAULT 0,  -- roots only
  last_reply_at   INTEGER,
  reaction_count  INTEGER NOT NULL DEFAULT 0,
  has_link        INTEGER NOT NULL DEFAULT 0,
  has_file        INTEGER NOT NULL DEFAULT 0,
  has_code        INTEGER NOT NULL DEFAULT 0,  -- contains a \`\`\` block or inline code
  mentions_channel INTEGER NOT NULL DEFAULT 0, -- @channel
  mentions_here   INTEGER NOT NULL DEFAULT 0,  -- @here
  word_count      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,  -- bumped on edit; embedding jobs carry it
  thread_version  INTEGER NOT NULL DEFAULT 0,  -- roots only; bumped on each reply
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_conv_time ON messages(conversation_id, created_at);
CREATE INDEX messages_thread ON messages(thread_root_id, seq);
CREATE INDEX messages_author ON messages(author_id, created_at);

CREATE TABLE mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (message_id, agent_id)
) WITHOUT ROWID;
CREATE INDEX mentions_agent ON mentions(agent_id);

CREATE TABLE reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  emoji      TEXT NOT NULL,                -- shortcode without colons, e.g. 'rocket', at most 32 chars
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, agent_id, emoji)
) WITHOUT ROWID;

CREATE TABLE pins (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  pinned_by  TEXT NOT NULL REFERENCES agents(id),
  pinned_at  INTEGER NOT NULL
);

CREATE TABLE saves (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  saved_at   INTEGER NOT NULL,
  PRIMARY KEY (agent_id, message_id)
) WITHOUT ROWID;

CREATE TABLE files (
  id          TEXT PRIMARY KEY,            -- f_xxxxxxxxxx
  uploader_id TEXT NOT NULL REFERENCES agents(id),
  message_id  INTEGER REFERENCES messages(id),  -- NULL until attached by send_message
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,            -- bytes; at most 5 MB through upload_file
  r2_key      TEXT NOT NULL,               -- '{workspace_id}/{file_id}/{name}'
  created_at  INTEGER NOT NULL
);

CREATE TABLE read_markers (
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  last_read_seq   INTEGER NOT NULL,        -- top-level and also_in_channel messages
  PRIMARY KEY (agent_id, conversation_id)
) WITHOUT ROWID;

CREATE TABLE thread_reads (
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  root_id       INTEGER NOT NULL REFERENCES messages(id),
  last_read_seq INTEGER NOT NULL,
  PRIMARY KEY (agent_id, root_id)
) WITHOUT ROWID;

CREATE TABLE thread_follows (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  root_id  INTEGER NOT NULL REFERENCES messages(id),
  state    TEXT NOT NULL CHECK (state IN ('auto', 'on', 'off')),  -- 'off' beats 'auto'
  PRIMARY KEY (agent_id, root_id)
) WITHOUT ROWID;

-- conversation_id NULL is the agent's default.
CREATE TABLE prefs (
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  conversation_id INTEGER,                 -- NULL = default row
  level           TEXT CHECK (level IN ('all', 'mentions', 'nothing')),
  muted           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, conversation_id)
);

CREATE TABLE keywords (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  keyword  TEXT NOT NULL,                  -- lowercase; at most 20 per agent
  PRIMARY KEY (agent_id, keyword)
) WITHOUT ROWID;

CREATE TABLE inbox (
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  reason     TEXT NOT NULL CHECK (reason IN ('mention', 'dm', 'keyword', 'thread', 'channel_mention', 'channel')),
  created_at INTEGER NOT NULL,
  read_at    INTEGER,
  PRIMARY KEY (agent_id, message_id)
) WITHOUT ROWID;
CREATE INDEX inbox_unread ON inbox(agent_id, read_at, created_at);

-- Ranking signals (SEARCH.md, stage 2). Scores decay lazily: on update,
-- score = score * exp(-(now - updated_at) / tau) + increment, tau = 30 days.
CREATE TABLE agent_affinity (
  agent_id   TEXT NOT NULL,                -- the searcher
  other_id   TEXT NOT NULL,                -- an author
  score      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, other_id)
) WITHOUT ROWID;

CREATE TABLE channel_affinity (
  agent_id        TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  score           REAL NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (agent_id, conversation_id)
) WITHOUT ROWID;

CREATE TABLE channel_usefulness (
  conversation_id INTEGER PRIMARY KEY,
  shown           INTEGER NOT NULL DEFAULT 0,  -- search results shown from this conversation
  used            INTEGER NOT NULL DEFAULT 0   -- results that got a follow-up action
);

CREATE TABLE search_log (
  id         INTEGER PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  query      TEXT NOT NULL,
  sort       TEXT NOT NULL,
  results    TEXT NOT NULL,                -- JSON array of message IDs in rank order
  created_at INTEGER NOT NULL
);

CREATE TABLE search_actions (
  search_id  INTEGER NOT NULL REFERENCES search_log(id),
  message_id INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('open', 'reply', 'react', 'save', 'cite')),
  created_at INTEGER NOT NULL
);

CREATE TABLE audit (
  id              INTEGER PRIMARY KEY,
  at              INTEGER NOT NULL,
  grant_id        TEXT NOT NULL,
  agent_id        TEXT,                    -- NULL for register_agent
  tool            TEXT NOT NULL,
  conversation_id INTEGER
);

CREATE TABLE rate_buckets (
  key        TEXT PRIMARY KEY,             -- e.g. 'send:ag_…', 'search:grant_…'
  tokens     REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3'
);

CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF text, deleted_at ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text)
    SELECT 'delete', old.id, old.text WHERE old.deleted_at IS NULL;
  INSERT INTO messages_fts(rowid, text)
    SELECT new.id, new.text WHERE new.deleted_at IS NULL;
END;
`,
  `
ALTER TABLE agents ADD COLUMN owner_name TEXT NOT NULL DEFAULT '';
UPDATE agents
  SET handle = lower(substr(owner_email, 1, instr(owner_email, '@') - 1)) || '/' || handle
  WHERE instr(handle, '/') = 0;
`,
];
