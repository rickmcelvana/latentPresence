-- The memory schema (P4-T01, ADR-05, ADR-35).
--
-- **No vector column is declared here.** An embedding model is the user's choice and its
-- width with it (768 for nomic-embed-text, 1024 for bge-m3, 1536 or 3072 for OpenAI's), while
-- MariaDB fixes a VECTOR(N) column's width when the table is created and allows one vector
-- index per table. So each collection gets a vector table per registered embedding model,
-- created by the companion when the model is registered (`memory::ensure_collection`):
--
--   turn_embeddings_<model>   fact_embeddings_<model>   chunk_embeddings_<model>
--     item_id  -> turns.id / facts.id / chunks.id, ON DELETE CASCADE
--     embedding VECTOR(<the model's width>) NOT NULL, VECTOR INDEX ... DISTANCE=cosine
--
-- Changing models builds a second table beside the first and retires the old one when it is
-- full; nothing here is rewritten. Deleting a row takes its vectors with it in every width
-- (verified 2026-09-27, docs/SURFACE.md).
--
-- Every row a character owns carries `character_id` (the persona id, e.g. `alice`): memory
-- is namespaced per character (P4-T03). Times are DATETIME(3) in UTC, written by the
-- companion — not TIMESTAMP, which converts through the session time zone and ends in 2038.

-- P0-T06's table keeps its data and its index under a name that says what it is for; the
-- documents' chunks below take the name.
RENAME TABLE chunks TO bench_chunks;

-- One conversation.
CREATE TABLE sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id VARCHAR(64)  NOT NULL,
  started_at   DATETIME(3)  NOT NULL,
  ended_at     DATETIME(3)  NULL,
  title        VARCHAR(255) NULL,
  KEY sessions_character (character_id, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The episodic log. An assistant turn's `text` is **what the user heard** (P1-T12b): an
-- interrupted answer is stored as its spoken prefix, with `interrupted` set.
CREATE TABLE turns (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id   BIGINT UNSIGNED NOT NULL,
  character_id VARCHAR(64)  NOT NULL,
  seq          INT UNSIGNED NOT NULL,
  role         ENUM('user', 'assistant') NOT NULL,
  text         MEDIUMTEXT   NOT NULL,
  interrupted  BOOLEAN      NOT NULL DEFAULT FALSE,
  -- The fused `UserAffect` at the turn (P3-T07), as the protocol's JSON; null when unknown.
  user_affect  JSON         NULL,
  created_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY turns_session_seq (session_id, seq),
  KEY turns_character_time (character_id, created_at),
  FULLTEXT KEY turns_text (text),
  CONSTRAINT turns_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
  CONSTRAINT turns_affect_json CHECK (user_affect IS NULL OR JSON_VALID(user_affect))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Semantic facts, bi-temporal: `valid_from`/`valid_to` are when it is true in the world,
-- `recorded_at`/`expired_at` when this store believed it. "I moved" closes the old address's
-- validity and records the new one with `supersedes`; nothing is overwritten, so what she
-- believed on any day can be asked.
CREATE TABLE facts (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id VARCHAR(64)  NOT NULL,
  subject      VARCHAR(255) NOT NULL,
  predicate    VARCHAR(255) NOT NULL,
  object       TEXT         NOT NULL,
  confidence   FLOAT        NOT NULL DEFAULT 1,
  valid_from   DATETIME(3)  NULL,
  valid_to     DATETIME(3)  NULL,
  recorded_at  DATETIME(3)  NOT NULL,
  expired_at   DATETIME(3)  NULL,
  supersedes   BIGINT UNSIGNED NULL,
  source_turn  BIGINT UNSIGNED NULL,
  KEY facts_current (character_id, expired_at, valid_to),
  KEY facts_subject (character_id, subject(64), predicate(64)),
  FULLTEXT KEY facts_text (subject, predicate, object),
  CONSTRAINT facts_supersedes FOREIGN KEY (supersedes) REFERENCES facts (id) ON DELETE SET NULL,
  CONSTRAINT facts_source_turn FOREIGN KEY (source_turn) REFERENCES turns (id) ON DELETE SET NULL,
  CONSTRAINT facts_confidence CHECK (confidence BETWEEN 0 AND 1),
  CONSTRAINT facts_validity CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Self-model and persona blocks the character edits with tools (Letta style): one value per
-- label, bounded, versioned so an edit can be compared with what it replaced.
CREATE TABLE self_blocks (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id VARCHAR(64)  NOT NULL,
  label        VARCHAR(64)  NOT NULL,
  value        TEXT         NOT NULL,
  char_limit   INT UNSIGNED NOT NULL DEFAULT 2000,
  version      INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY self_blocks_label (character_id, label),
  CONSTRAINT self_blocks_limit CHECK (CHAR_LENGTH(value) <= char_limit)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plans and brainstorms: a document with a goal, and its phases and tasks as a tree.
CREATE TABLE plans (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id VARCHAR(64)  NOT NULL,
  title        VARCHAR(255) NOT NULL,
  goal         TEXT         NULL,
  status       ENUM('draft', 'active', 'done', 'dropped') NOT NULL DEFAULT 'draft',
  version      INT UNSIGNED NOT NULL DEFAULT 1,
  created_at   DATETIME(3)  NOT NULL,
  updated_at   DATETIME(3)  NOT NULL,
  KEY plans_character (character_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE plan_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id      BIGINT UNSIGNED NOT NULL,
  parent_id    BIGINT UNSIGNED NULL,
  position     INT UNSIGNED NOT NULL,
  kind         ENUM('phase', 'task', 'note') NOT NULL,
  title        VARCHAR(512) NOT NULL,
  body         TEXT         NULL,
  status       ENUM('todo', 'doing', 'done', 'dropped') NOT NULL DEFAULT 'todo',
  due_at       DATETIME(3)  NULL,
  updated_at   DATETIME(3)  NOT NULL,
  KEY plan_items_order (plan_id, parent_id, position),
  CONSTRAINT plan_items_plan FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
  CONSTRAINT plan_items_parent FOREIGN KEY (parent_id) REFERENCES plan_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ingested documents (P5). `character_id` null: shared by every character.
CREATE TABLE documents (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  character_id VARCHAR(64)   NULL,
  title        VARCHAR(512)  NOT NULL,
  source       VARCHAR(2048) NOT NULL,
  mime         VARCHAR(127)  NOT NULL,
  sha256       BINARY(32)    NOT NULL,
  bytes        BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME(3)   NOT NULL,
  KEY documents_hash (sha256),
  KEY documents_character (character_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chunks (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  document_id  BIGINT UNSIGNED NOT NULL,
  seq          INT UNSIGNED NOT NULL,
  text         MEDIUMTEXT   NOT NULL,
  created_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY chunks_document_seq (document_id, seq),
  FULLTEXT KEY chunks_text (text),
  CONSTRAINT chunks_document FOREIGN KEY (document_id) REFERENCES documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The embedding models this store has vectors from. `provider` is where the model runs
-- (an endpoint preset or `browser`), so the same model name served by two providers that
-- quantise it differently is two models. 16383 is MariaDB's VECTOR limit.
CREATE TABLE model_registry (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  purpose      ENUM('embedding') NOT NULL,
  provider     VARCHAR(128) NOT NULL,
  model        VARCHAR(255) NOT NULL,
  dimensions   SMALLINT UNSIGNED NOT NULL,
  created_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY model_registry_identity (purpose, provider, model, dimensions),
  CONSTRAINT model_registry_dimensions CHECK (dimensions BETWEEN 1 AND 16383)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which vector table holds a collection's vectors from a model, and whether retrieval uses
-- it: `building` while it is being filled (a re-index), `active` for the one retrieval reads,
-- `retired` once replaced. The table name is derived from the ids, never from user text.
CREATE TABLE vector_collections (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  collection   ENUM('turns', 'facts', 'chunks') NOT NULL,
  model_id     INT UNSIGNED NOT NULL,
  table_name   VARCHAR(64)  NOT NULL,
  status       ENUM('building', 'active', 'retired') NOT NULL DEFAULT 'building',
  created_at   DATETIME(3)  NOT NULL,
  UNIQUE KEY vector_collections_identity (collection, model_id),
  UNIQUE KEY vector_collections_table (table_name),
  CONSTRAINT vector_collections_model FOREIGN KEY (model_id) REFERENCES model_registry (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
