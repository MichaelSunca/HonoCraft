-- Retention starts at the last lifecycle transition, not original upload time.
CREATE INDEX file_objects_cleanup_updated ON file_objects(state,updated_at,id);
DROP INDEX file_objects_cleanup;
