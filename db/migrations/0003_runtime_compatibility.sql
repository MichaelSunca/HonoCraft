-- Workers verify release checksums at startup without gaining schema write privileges.
GRANT SELECT ON migration_history TO honocraft_worker;
