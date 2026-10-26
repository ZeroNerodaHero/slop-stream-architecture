-- an account's id. the name can change; logins, memberships and who made a group stay put.
-- a session keeps the name it went live under, and gains the id when that session was the account's.
-- the name columns stay, and follow a rename, until a later migration drops them.

ALTER TABLE streamers ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX streamers_id_idx ON streamers (id);
ALTER TABLE streamers ADD COLUMN renamed_at timestamptz;

ALTER TABLE logins ADD COLUMN user_id uuid REFERENCES streamers(id) ON DELETE CASCADE;
UPDATE logins l SET user_id = s.id FROM streamers s WHERE s.name = l.name;
CREATE INDEX logins_user_idx ON logins (user_id);

ALTER TABLE memberships ADD COLUMN user_id uuid REFERENCES streamers(id) ON DELETE CASCADE;
UPDATE memberships m SET user_id = s.id FROM streamers s WHERE s.name = m.name;
CREATE UNIQUE INDEX memberships_user_group_idx ON memberships (user_id, group_name);

ALTER TABLE groups ADD COLUMN created_by_id uuid REFERENCES streamers(id) ON DELETE SET NULL;
UPDATE groups g SET created_by_id = s.id FROM streamers s WHERE s.name = g.created_by;

ALTER TABLE sessions ADD COLUMN user_id uuid;
UPDATE sessions se SET user_id = s.id FROM streamers s WHERE s.name = se.name AND se.verified;

ALTER TABLE logins DROP CONSTRAINT logins_name_fkey;
ALTER TABLE logins ADD CONSTRAINT logins_name_fkey
    FOREIGN KEY (name) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE memberships DROP CONSTRAINT memberships_name_fkey;
ALTER TABLE memberships ADD CONSTRAINT memberships_name_fkey
    FOREIGN KEY (name) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE groups DROP CONSTRAINT groups_created_by_fkey;
ALTER TABLE groups ADD CONSTRAINT groups_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE TABLE held_names (
    name text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    until timestamptz NOT NULL
);
