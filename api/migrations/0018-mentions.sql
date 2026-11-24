CREATE INDEX streamers_name_prefix_idx ON streamers (name text_pattern_ops);
ALTER TABLE chat_lines ADD COLUMN mentions text[] NOT NULL DEFAULT '{}';
ALTER TABLE dms ADD COLUMN mentions text[] NOT NULL DEFAULT '{}';
