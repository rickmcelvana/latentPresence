-- The memory store's one table, as P0-T06 measures it (ADR-05, ADR-17).
--
-- `NOT NULL` on the vector is required by MariaDB, not stylistic: an indexed VECTOR column
-- may not be nullable, and a table may carry only one vector index.
--
-- `DISTANCE=cosine` is declared rather than left to default, and the default is euclidean.
-- A query using a distance function the index was not built with silently falls back to a
-- full table scan - it returns the right rows, slowly, with no error and no warning - so
-- the index and every query that touches it have to agree. See docs/SURFACE.md.
--
-- M=8 is above the server's default of 6: slightly more memory and build time for better
-- recall. The spike reports what it measured against.
CREATE TABLE IF NOT EXISTS chunks (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doc_id     BIGINT UNSIGNED NOT NULL,
  text       MEDIUMTEXT NOT NULL,
  embedding  VECTOR(768) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY doc_id_idx (doc_id),
  VECTOR INDEX (embedding) M=8 DISTANCE=cosine
) ENGINE=InnoDB;
