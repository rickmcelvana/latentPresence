-- The schema meets the companion's contract (P4-T02, ADR-36).
--
-- **Ids are the caller's.** The memory kernel writes without waiting (ADR-17: writes never
-- block the speaking path) and must still be able to say "this fact came from that turn",
-- so it makes the ids (`IdSchema`: an opaque string up to 128 characters) and the store keeps
-- them in `uid`. The integer `id` stays the primary key: it is what the vector tables' foreign
-- keys point at (ADR-35) and what joins use, and it never leaves the companion.
--
-- The tables are empty when this runs on any real install (P4-T01 shipped nothing that
-- writes them; `memory-check` cleans up after itself), so the new NOT NULL columns need no
-- backfill.

ALTER TABLE sessions
  ADD COLUMN uid VARCHAR(128) NOT NULL AFTER id,
  ADD UNIQUE KEY sessions_uid (uid);

ALTER TABLE turns
  ADD COLUMN uid VARCHAR(128) NOT NULL AFTER id,
  ADD UNIQUE KEY turns_uid (uid);

ALTER TABLE facts
  ADD COLUMN uid VARCHAR(128) NOT NULL AFTER id,
  ADD UNIQUE KEY facts_uid (uid);

ALTER TABLE plans
  ADD COLUMN uid VARCHAR(128) NOT NULL AFTER id,
  ADD UNIQUE KEY plans_uid (uid),
  -- The protocol's word for a plan put away is `archived` (`PlanDocumentSchema`).
  MODIFY COLUMN status ENUM('draft', 'active', 'done', 'archived') NOT NULL DEFAULT 'draft';

-- A phase's or task's id is unique within its plan: a saved plan replaces its items.
ALTER TABLE plan_items
  ADD COLUMN uid VARCHAR(128) NOT NULL AFTER id,
  ADD UNIQUE KEY plan_items_uid (plan_id, uid);

-- Blocks only the user may change, like hard boundaries (`SelfModelBlockSchema`).
ALTER TABLE self_blocks
  ADD COLUMN editable_by_character BOOLEAN NOT NULL DEFAULT TRUE AFTER value;
