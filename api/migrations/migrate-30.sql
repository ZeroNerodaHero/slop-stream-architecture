-- a trigram index on the names for the search box (follows.rs `search`): `LIKE 'ab%'` and
-- `LIKE '%abc%'` alike, once the table outgrows a read of the whole of it. pg_trgm ships with
-- postgres; the extension is per database.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX streamers_name_trgm_idx ON streamers USING gin (name gin_trgm_ops);
