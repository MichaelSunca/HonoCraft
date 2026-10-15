-- Variants share the parent file's lifecycle and authorization; only favicon 32 is supported.
CREATE TABLE file_variants (
  file_id uuid NOT NULL REFERENCES file_objects(id) ON DELETE CASCADE,
  size smallint NOT NULL CHECK(size=32),
  storage_key text NOT NULL UNIQUE CHECK(storage_key=file_id::text||'-32.png'),
  byte_size bigint NOT NULL CHECK(byte_size>=0),
  PRIMARY KEY(file_id,size)
);
GRANT SELECT,INSERT,DELETE ON file_variants TO honocraft_web;
GRANT SELECT,DELETE ON file_variants TO honocraft_worker,honocraft_maintenance;
