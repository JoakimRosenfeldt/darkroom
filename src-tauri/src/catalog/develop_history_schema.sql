
      CREATE TABLE IF NOT EXISTS develop_history_revisions (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        parent_revision_id TEXT,
        operation_id TEXT NOT NULL,
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
        assets_indexed INTEGER NOT NULL DEFAULT 0 CHECK (assets_indexed IN (0, 1)),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        label TEXT NOT NULL CHECK (length(trim(label)) > 0 AND length(label) <= 120),
        document_sha256 TEXT NOT NULL CHECK (length(document_sha256) = 64),
        checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
        patch_json TEXT CHECK (patch_json IS NULL OR json_valid(patch_json)),
        created_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id, revision_id),
        UNIQUE (catalog_id, entry_id, operation_id),
        UNIQUE (catalog_id, entry_id, ordinal),
        CHECK ((parent_revision_id IS NULL AND ordinal = 0 AND checkpoint_json IS NOT NULL AND patch_json IS NULL) OR
               (parent_revision_id IS NOT NULL AND ordinal > 0 AND ((checkpoint_json IS NULL) <> (patch_json IS NULL)))),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, parent_revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_history_heads (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        updated_at REAL NOT NULL,
        retention_floor_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (retention_floor_ordinal >= 0),
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_revision_assets (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        asset_sha256 TEXT NOT NULL CHECK (length(asset_sha256) = 64),
        PRIMARY KEY (catalog_id, entry_id, revision_id, asset_sha256),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_history_refs (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('version', 'snapshot')),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
        revision_id TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id, ref_id),
        UNIQUE (catalog_id, entry_id, kind, name),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_xmp_projections (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        projected_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS develop_default_installs (
        catalog_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        created_at REAL NOT NULL,
        PRIMARY KEY (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id),
        FOREIGN KEY (catalog_id, entry_id, revision_id)
          REFERENCES develop_history_revisions (catalog_id, entry_id, revision_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS develop_history_revisions_by_entry
        ON develop_history_revisions (catalog_id, entry_id, ordinal DESC);
      CREATE INDEX IF NOT EXISTS develop_history_refs_by_entry
        ON develop_history_refs (catalog_id, entry_id, kind, created_at, ref_id);
      CREATE INDEX IF NOT EXISTS develop_revision_assets_by_hash
        ON develop_revision_assets (catalog_id, asset_sha256);
