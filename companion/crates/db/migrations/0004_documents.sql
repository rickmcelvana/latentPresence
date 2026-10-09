-- Document ingestion (P5-T03, ADR-44).
--
-- `documents` and `chunks` came with 0002 for "ingested documents (P5)". Ingestion needs to know
-- more about a document than that table did:
--
--   folder       the configured folder (canonical) the file was found under, so a scan can ask
--                "what do I have under this folder" and remove what is no longer on disk.
--                Binary-collated: two folders on a case-sensitive file system are two folders.
--   path_key     SHA-256 of the file's full path as UTF-8, UNIQUE: a document is keyed by its
--                path, and a binary key of fixed width indexes where a 2048-character path
--                cannot. NULL for a document that did not come from a folder.
--   modified_at  the file's modified time, which with `bytes` is the first, cheap test for
--                "unchanged" - a file that matches is not even read.
--   model_id     the `model_registry` row its chunks were embedded with. NULL: indexed for
--                keyword search only (`FULLTEXT chunks_text`). A document indexed with another
--                model than the configured one is embedded again.
--   indexed_at   when its chunks were written.
--
-- A chunk's `locator` is the page it came from (`p. 12` for a PDF; NULL for formats without
-- pages), so a citation can say where (ADR-44: chunks never cross a page).
--
-- A document's vectors go with it: `chunk_embeddings_<model>.item_id` cascades from `chunks`,
-- and `chunks.document_id` from `documents` (0002, ADR-35).

ALTER TABLE documents
  ADD COLUMN folder VARCHAR(2048) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '' AFTER source,
  ADD COLUMN path_key BINARY(32) NULL AFTER folder,
  ADD COLUMN modified_at DATETIME(3) NULL AFTER bytes,
  ADD COLUMN model_id INT UNSIGNED NULL AFTER modified_at,
  ADD COLUMN indexed_at DATETIME(3) NULL AFTER model_id,
  ADD UNIQUE KEY documents_path (path_key),
  ADD KEY documents_folder (folder(255)),
  ADD CONSTRAINT documents_model FOREIGN KEY (model_id) REFERENCES model_registry (id) ON DELETE SET NULL;

ALTER TABLE chunks
  ADD COLUMN locator VARCHAR(64) NULL AFTER seq;
