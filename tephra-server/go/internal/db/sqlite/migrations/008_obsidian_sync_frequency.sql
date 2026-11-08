ALTER TABLE obsidian_sync ADD COLUMN frequency TEXT NOT NULL DEFAULT 'continuous'
  CHECK (frequency IN ('continuous', '6h', '1h', '30m', '10m'));
