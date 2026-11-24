CREATE INDEX streamers_people_idx ON streamers ((password_hash IS NOT NULL) DESC, updated_at DESC);
