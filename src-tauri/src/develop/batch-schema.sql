
    CREATE TABLE develop_batch_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 2)
    ) STRICT;
    INSERT INTO develop_batch_schema_meta (singleton, schema_version) VALUES (1, 2);
  
    CREATE TABLE develop_batch_jobs (
      catalog_id TEXT NOT NULL, batch_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      kind TEXT NOT NULL CHECK (kind IN ('previous', 'sync', 'auto-sync', 'batch', 'undo')),
      source_entry_id TEXT, source_revision_id TEXT,
      operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
      cancellation_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_requested IN (0, 1)),
      created_at REAL NOT NULL, updated_at REAL NOT NULL,
      emission_sequence INTEGER CHECK (emission_sequence IS NULL OR emission_sequence >= 1),
      PRIMARY KEY (catalog_id, batch_id), UNIQUE (catalog_id, operation_id),
      CHECK ((source_entry_id IS NULL) = (source_revision_id IS NULL)),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE develop_batch_items (
      catalog_id TEXT NOT NULL, batch_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0),
      entry_id TEXT NOT NULL, operation_id TEXT NOT NULL, planned_revision_id TEXT NOT NULL,
      expected_revision_id TEXT NOT NULL, before_revision_id TEXT, after_revision_id TEXT, restore_revision_id TEXT,
      state_json TEXT NOT NULL CHECK (json_valid(state_json)), attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      updated_at REAL NOT NULL, PRIMARY KEY (catalog_id, batch_id, position),
      UNIQUE (catalog_id, batch_id, entry_id), UNIQUE (catalog_id, batch_id, operation_id),
      UNIQUE (catalog_id, batch_id, planned_revision_id),
      FOREIGN KEY (catalog_id, batch_id) REFERENCES develop_batch_jobs (catalog_id, batch_id),
      FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
    CREATE TABLE develop_auto_sync (
      catalog_id TEXT NOT NULL PRIMARY KEY, source_entry_id TEXT NOT NULL, source_revision_id TEXT NOT NULL,
      targets_json TEXT NOT NULL CHECK (json_valid(targets_json)), fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), updated_at REAL NOT NULL,
      source_emission_sequence INTEGER NOT NULL DEFAULT 0 CHECK (source_emission_sequence >= 0),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, source_entry_id) REFERENCES edit_entries (catalog_id, entry_id)
    ) STRICT;
  