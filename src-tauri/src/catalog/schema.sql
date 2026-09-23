
    BEGIN IMMEDIATE;

    PRAGMA application_id = 1146243891;
    PRAGMA user_version = 3;

    CREATE TABLE IF NOT EXISTS catalog_meta (
      catalog_id TEXT PRIMARY KEY CHECK (catalog_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(catalog_id) = catalog_id),
      singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
      display_name TEXT NOT NULL CHECK (length(display_name) > 0),
      schema_version INTEGER NOT NULL CHECK (schema_version = 3),
      app_version TEXT NOT NULL CHECK (length(app_version) > 0),
      install_state TEXT NOT NULL CHECK (install_state IN ('staging', 'ready')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_runs (
      catalog_id TEXT NOT NULL,
      migration_id TEXT NOT NULL CHECK (migration_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(migration_id) = migration_id),
      source_version INTEGER NOT NULL CHECK (source_version IN (1, 2)),
      catalog_path TEXT NOT NULL CHECK (length(catalog_path) > 0 AND instr(catalog_path, char(0)) = 0),
      settings_path TEXT,
      catalog_sha256 TEXT NOT NULL CHECK ((catalog_sha256 IS NULL OR (catalog_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(catalog_sha256) = catalog_sha256))),
      settings_sha256 TEXT CHECK ((settings_sha256 IS NULL OR (settings_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(settings_sha256) = settings_sha256))),
      root_available INTEGER NOT NULL CHECK (root_available IN (0, 1)),
      expected_counts_json TEXT NOT NULL CHECK (json_valid(expected_counts_json)),
      expected_state_sha256 TEXT NOT NULL CHECK ((expected_state_sha256 IS NULL OR (expected_state_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(expected_state_sha256) = expected_state_sha256))),
      phase TEXT NOT NULL CHECK (phase IN ('created', 'copying-assets', 'copying-relations', 'copied', 'validating', 'validated', 'failed')),
      validation_report_json TEXT CHECK (validation_report_json IS NULL OR json_valid(validation_report_json)),
      error_message TEXT,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, migration_id),
      CHECK ((settings_path IS NULL) = (settings_sha256 IS NULL)),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS roots (
      catalog_id TEXT NOT NULL,
      root_id TEXT NOT NULL CHECK (root_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(root_id) = root_id),
      label TEXT NOT NULL CHECK (length(label) > 0 AND instr(label, char(0)) = 0),
      configured_path TEXT NOT NULL CHECK (length(configured_path) > 0 AND instr(configured_path, char(0)) = 0),
      canonical_path TEXT CHECK (canonical_path IS NULL OR (length(canonical_path) > 0 AND instr(canonical_path, char(0)) = 0)),
      health TEXT NOT NULL CHECK (health IN ('online', 'missing', 'ambiguous', 'unreadable')),
      scan_state TEXT NOT NULL CHECK (scan_state IN ('unknown', 'complete', 'partial', 'failed')),
      watch_state TEXT NOT NULL CHECK (watch_state IN ('disabled', 'active', 'error')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      CHECK (health <> 'online' OR canonical_path IS NOT NULL),
      PRIMARY KEY (catalog_id, root_id),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS assets (
      catalog_id TEXT NOT NULL,
      asset_id TEXT NOT NULL CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      root_id TEXT NOT NULL CHECK (root_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(root_id) = root_id),
      relative_path TEXT NOT NULL CHECK (
        length(relative_path) > 0
        AND instr(relative_path, char(0)) = 0
        AND substr(relative_path, 1, 1) <> '/'
        AND instr(relative_path, char(92)) = 0
        AND relative_path NOT LIKE '../%'
        AND relative_path NOT LIKE '%/../%'
        AND relative_path NOT LIKE '%/..'
        AND relative_path <> '..'
        AND relative_path NOT LIKE './%'
        AND relative_path NOT LIKE '%/./%'
        AND relative_path NOT LIKE '%/.'
        AND relative_path <> '.'
        AND relative_path NOT LIKE '%//%'
        AND substr(relative_path, 2, 1) <> ':'
      ),
      observed_byte_length INTEGER CHECK (observed_byte_length IS NULL OR observed_byte_length >= 0),
      observed_modified_at REAL,
      observed_at REAL,
      local_file_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      health TEXT NOT NULL CHECK (health IN ('present', 'missing', 'ambiguous', 'unreadable')),
      format_id TEXT NOT NULL CHECK (length(format_id) > 0),
      camera_make TEXT,
      camera_model TEXT,
      lens_model TEXT,
      PRIMARY KEY (catalog_id, asset_id),
      UNIQUE (catalog_id, root_id, relative_path),
      FOREIGN KEY (catalog_id, root_id) REFERENCES roots (catalog_id, root_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS asset_metadata (
      catalog_id TEXT NOT NULL,
      asset_id TEXT NOT NULL CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1)),
      pick TEXT NOT NULL CHECK (pick IN ('none', 'pick', 'reject')),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
      color_label TEXT CHECK (color_label IS NULL OR color_label IN ('red', 'yellow', 'green', 'blue', 'purple')),
      develop_json TEXT CHECK (develop_json IS NULL OR json_valid(develop_json)),
      develop_updated_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      title TEXT,
      caption TEXT,
      copyright TEXT,
      keywords_json TEXT NOT NULL CHECK (json_valid(keywords_json) AND json_type(keywords_json) = 'array'),
      raw_xmp TEXT,
      xmp_state TEXT NOT NULL CHECK (xmp_state IN ('unknown', 'absent', 'preserved', 'malformed')),
      xmp_mtime REAL,
      xmp_sha256 TEXT CHECK ((xmp_sha256 IS NULL OR (xmp_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(xmp_sha256) = xmp_sha256))),
      PRIMARY KEY (catalog_id, asset_id),
      CHECK ((xmp_state = 'preserved') = (raw_xmp IS NOT NULL)),
      CHECK (xmp_state <> 'absent' OR raw_xmp IS NULL),
      FOREIGN KEY (catalog_id, asset_id) REFERENCES assets (catalog_id, asset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS edit_entries (
      catalog_id TEXT NOT NULL,
      entry_id TEXT NOT NULL CHECK (entry_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(entry_id) = entry_id),
      source_id TEXT NOT NULL CHECK (source_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(source_id) = source_id),
      is_original INTEGER NOT NULL CHECK (is_original IN (0, 1)),
      parent_entry_id TEXT CHECK (parent_entry_id IS NULL OR parent_entry_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(parent_entry_id) = parent_entry_id),
      display_name TEXT CHECK (display_name IS NULL OR (length(trim(display_name)) > 0 AND instr(display_name, char(0)) = 0)),
      tombstoned_at REAL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, entry_id),
      FOREIGN KEY (catalog_id, source_id) REFERENCES assets (catalog_id, asset_id) ON UPDATE CASCADE
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS edit_entries_one_original_per_source
      ON edit_entries (catalog_id, source_id)
      WHERE is_original = 1;

    CREATE TABLE IF NOT EXISTS entry_metadata (
      catalog_id TEXT NOT NULL,
      entry_id TEXT NOT NULL CHECK (entry_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(entry_id) = entry_id),
      archive INTEGER NOT NULL DEFAULT 0 CHECK (archive IN (0, 1)),
      pick TEXT NOT NULL CHECK (pick IN ('none', 'pick', 'reject')),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
      color_label TEXT CHECK (color_label IS NULL OR color_label IN ('red', 'yellow', 'green', 'blue', 'purple')),
      develop_json TEXT CHECK (develop_json IS NULL OR json_valid(develop_json)),
      develop_updated_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      title TEXT,
      caption TEXT,
      copyright TEXT,
      keywords_json TEXT NOT NULL CHECK (json_valid(keywords_json) AND json_type(keywords_json) = 'array'),
      raw_xmp TEXT,
      xmp_state TEXT NOT NULL CHECK (xmp_state IN ('unknown', 'absent', 'preserved', 'malformed')),
      xmp_mtime REAL,
      xmp_sha256 TEXT CHECK ((xmp_sha256 IS NULL OR (xmp_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(xmp_sha256) = xmp_sha256))),
      PRIMARY KEY (catalog_id, entry_id),
      CHECK ((xmp_state = 'preserved') = (raw_xmp IS NOT NULL)),
      CHECK (xmp_state <> 'absent' OR raw_xmp IS NULL),
      FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id) ON UPDATE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS albums (
      catalog_id TEXT NOT NULL,
      album_id TEXT NOT NULL CHECK (length(album_id) > 0),
      name TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (catalog_id, album_id),
      UNIQUE (catalog_id, position),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS album_assets (
      catalog_id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      asset_id TEXT NOT NULL CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (catalog_id, album_id, position),
      UNIQUE (catalog_id, album_id, asset_id),
      FOREIGN KEY (catalog_id, album_id) REFERENCES albums (catalog_id, album_id),
      FOREIGN KEY (catalog_id, asset_id) REFERENCES assets (catalog_id, asset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS album_entries (
      catalog_id TEXT NOT NULL,
      album_id TEXT NOT NULL,
      entry_id TEXT NOT NULL CHECK (entry_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(entry_id) = entry_id),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (catalog_id, album_id, position),
      UNIQUE (catalog_id, album_id, entry_id),
      FOREIGN KEY (catalog_id, album_id) REFERENCES albums (catalog_id, album_id) ON UPDATE CASCADE,
      FOREIGN KEY (catalog_id, entry_id) REFERENCES edit_entries (catalog_id, entry_id) ON UPDATE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS fingerprints (
      catalog_id TEXT NOT NULL,
      fingerprint_id TEXT NOT NULL CHECK (fingerprint_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(fingerprint_id) = fingerprint_id),
      asset_id TEXT NOT NULL CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      status TEXT NOT NULL CHECK (status IN ('missing', 'hashing', 'valid', 'stale', 'failed')),
      sha256 TEXT CHECK ((sha256 IS NULL OR (sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(sha256) = sha256))),
      observed_at REAL,
      observed_byte_length INTEGER CHECK (observed_byte_length IS NULL OR observed_byte_length >= 0),
      observed_modified_at REAL,
      local_file_id TEXT,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, fingerprint_id),
      UNIQUE (catalog_id, asset_id),
      CHECK ((status = 'valid') = (sha256 IS NOT NULL)),
      CHECK (status <> 'valid' OR (observed_at IS NOT NULL AND (observed_byte_length IS NOT NULL OR observed_modified_at IS NOT NULL OR local_file_id IS NOT NULL))),
      FOREIGN KEY (catalog_id, asset_id) REFERENCES assets (catalog_id, asset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS import_presets (
      catalog_id TEXT NOT NULL,
      preset_id TEXT NOT NULL CHECK (preset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(preset_id) = preset_id),
      name TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, preset_id),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS auto_import_rules (
      catalog_id TEXT NOT NULL,
      rule_id TEXT NOT NULL CHECK (rule_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(rule_id) = rule_id),
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      destination_root_id TEXT NOT NULL CHECK (destination_root_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(destination_root_id) = destination_root_id),
      preset_id TEXT NOT NULL CHECK (preset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(preset_id) = preset_id),
      config_json TEXT NOT NULL CHECK (json_valid(config_json)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, rule_id),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, destination_root_id) REFERENCES roots (catalog_id, root_id),
      FOREIGN KEY (catalog_id, preset_id) REFERENCES import_presets (catalog_id, preset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS operations (
      catalog_id TEXT NOT NULL,
      operation_id TEXT NOT NULL CHECK (operation_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(operation_id) = operation_id),
      kind TEXT NOT NULL CHECK (length(kind) > 0),
      state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, operation_id),
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS operation_items (
      catalog_id TEXT NOT NULL,
      operation_id TEXT NOT NULL CHECK (operation_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(operation_id) = operation_id),
      item_id TEXT NOT NULL CHECK (length(item_id) > 0),
      asset_id TEXT CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      state TEXT NOT NULL CHECK (state IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (catalog_id, operation_id, item_id),
      FOREIGN KEY (catalog_id, operation_id) REFERENCES operations (catalog_id, operation_id),
      FOREIGN KEY (catalog_id, asset_id) REFERENCES assets (catalog_id, asset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS migration_aliases (
      catalog_id TEXT NOT NULL,
      migration_id TEXT NOT NULL CHECK (migration_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(migration_id) = migration_id),
      legacy_id TEXT NOT NULL CHECK (length(legacy_id) > 0),
      root_id TEXT NOT NULL CHECK (root_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(root_id) = root_id),
      relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
      asset_id TEXT NOT NULL CHECK (asset_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]' AND lower(asset_id) = asset_id),
      created_at REAL NOT NULL,
      PRIMARY KEY (catalog_id, migration_id, legacy_id),
      UNIQUE (catalog_id, migration_id, root_id, relative_path, legacy_id),
      FOREIGN KEY (catalog_id, migration_id) REFERENCES migration_runs (catalog_id, migration_id),
      FOREIGN KEY (catalog_id, root_id) REFERENCES roots (catalog_id, root_id),
      FOREIGN KEY (catalog_id, asset_id) REFERENCES assets (catalog_id, asset_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS audit_log (
      audit_id INTEGER PRIMARY KEY,
      catalog_id TEXT NOT NULL,
      migration_id TEXT,
      event TEXT NOT NULL CHECK (length(event) > 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at REAL NOT NULL,
      FOREIGN KEY (catalog_id) REFERENCES catalog_meta (catalog_id),
      FOREIGN KEY (catalog_id, migration_id) REFERENCES migration_runs (catalog_id, migration_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS assets_by_catalog_path
      ON assets (catalog_id, root_id, relative_path);
    CREATE INDEX IF NOT EXISTS album_assets_by_asset
      ON album_assets (catalog_id, asset_id);
    CREATE INDEX IF NOT EXISTS edit_entries_by_source
      ON edit_entries (catalog_id, source_id, entry_id);
    CREATE INDEX IF NOT EXISTS album_entries_by_entry
      ON album_entries (catalog_id, entry_id);

    CREATE TRIGGER IF NOT EXISTS assets_create_original_entry
    AFTER INSERT ON assets
    BEGIN
      INSERT OR IGNORE INTO edit_entries (
        catalog_id, entry_id, source_id, is_original, created_at, updated_at
      ) VALUES (
        NEW.catalog_id, NEW.asset_id, NEW.asset_id, 1,
        COALESCE(NEW.observed_at, 0), COALESCE(NEW.observed_at, 0)
      );
    END;

    CREATE TRIGGER IF NOT EXISTS asset_metadata_create_entry_metadata
    AFTER INSERT ON asset_metadata
    BEGIN
      INSERT OR IGNORE INTO entry_metadata (
        catalog_id, entry_id, archive, pick, rating, color_label, develop_json,
        develop_updated_at, updated_at, title, caption, copyright, keywords_json,
        raw_xmp, xmp_state, xmp_mtime, xmp_sha256
      ) VALUES (
        NEW.catalog_id, NEW.asset_id, NEW.archive, NEW.pick, NEW.rating,
        NEW.color_label, NEW.develop_json, NEW.develop_updated_at, NEW.updated_at,
        NEW.title, NEW.caption, NEW.copyright, NEW.keywords_json, NEW.raw_xmp,
        NEW.xmp_state, NEW.xmp_mtime, NEW.xmp_sha256
      );
    END;

    CREATE TRIGGER IF NOT EXISTS asset_metadata_sync_entry_metadata
    AFTER UPDATE ON asset_metadata
    BEGIN
      UPDATE entry_metadata SET
        archive = NEW.archive, pick = NEW.pick, rating = NEW.rating,
        color_label = NEW.color_label, develop_json = NEW.develop_json,
        develop_updated_at = NEW.develop_updated_at, updated_at = NEW.updated_at,
        title = NEW.title, caption = NEW.caption, copyright = NEW.copyright,
        keywords_json = NEW.keywords_json, raw_xmp = NEW.raw_xmp,
        xmp_state = NEW.xmp_state, xmp_mtime = NEW.xmp_mtime,
        xmp_sha256 = NEW.xmp_sha256
      WHERE catalog_id = NEW.catalog_id AND entry_id = NEW.asset_id;
    END;

    CREATE TRIGGER IF NOT EXISTS album_assets_create_album_entry
    AFTER INSERT ON album_assets
    BEGIN
      INSERT OR IGNORE INTO album_entries (catalog_id, album_id, entry_id, position)
      VALUES (NEW.catalog_id, NEW.album_id, NEW.asset_id, NEW.position);
    END;
    CREATE INDEX IF NOT EXISTS migration_aliases_by_asset
      ON migration_aliases (catalog_id, migration_id, asset_id, legacy_id);
    CREATE INDEX IF NOT EXISTS fingerprints_by_catalog_digest
      ON fingerprints (catalog_id, sha256)
      WHERE sha256 IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS auto_import_one_enabled_per_catalog
      ON auto_import_rules (catalog_id)
      WHERE enabled = 1;
    CREATE INDEX IF NOT EXISTS audit_log_by_catalog_time
      ON audit_log (catalog_id, created_at, audit_id);

    COMMIT;
  