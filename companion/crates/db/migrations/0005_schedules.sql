-- P6-T07b (ADR-57): schedules (ADR-14). Kept whole, as the protocol's `Schedule` has them (`body`),
-- beside the columns they are looked up by: a character's list, and the companion's own runner
-- asking which of its jobs are due. The page writes them; the companion's runner moves its own on.
CREATE TABLE schedules (
  uid          VARCHAR(128) NOT NULL PRIMARY KEY,
  character_id VARCHAR(64)  NOT NULL,
  run_on       VARCHAR(16)  NOT NULL,
  status       VARCHAR(16)  NOT NULL,
  next_run_at  DATETIME(3)  NULL,
  body         LONGTEXT     NOT NULL,
  updated_at   DATETIME(3)  NOT NULL,
  CONSTRAINT schedules_body_json CHECK (JSON_VALID(body)),
  KEY schedules_character (character_id, uid),
  KEY schedules_due (run_on, status, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
