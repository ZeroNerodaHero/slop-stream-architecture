-- The channel a group starts with is marked, not named (channel renames). Additive: one column
-- and one index.
--
-- A group is made with a text channel called `general`, and until now that name was how the api
-- knew it: never deleted, never kept to a role, the room's page when no channel is asked for.
-- `home` says so instead, so the channel keeps all that under any name it is given. Each group's
-- `general` is its home channel; at most one per group.

ALTER TABLE channels ADD COLUMN home boolean DEFAULT false NOT NULL;

UPDATE channels SET home = true WHERE name = 'general' AND kind = 'text';

CREATE UNIQUE INDEX channels_one_home ON channels (server) WHERE home;
