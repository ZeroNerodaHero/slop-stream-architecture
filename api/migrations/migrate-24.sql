-- the channels of a server in the order whoever holds the channels power put them
-- (docs/groups.md): the manage dialog's channels tab moves them, and every list reads the
-- position before the age. every channel that exists is numbered as it was listed until now,
-- by when it was made, `general` first; a new one goes after the last.
ALTER TABLE channels ADD COLUMN position integer NOT NULL DEFAULT 0;
UPDATE channels c SET position = n.position
FROM (SELECT server, name, row_number() OVER (PARTITION BY server ORDER BY created_at, name) - 1 AS position FROM channels) n
WHERE n.server = c.server AND n.name = c.name;
