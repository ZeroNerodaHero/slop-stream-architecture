-- a role is known by a uuid, not a counter (docs/ids.md, docs/groups.md): the manage dialog
-- opens a role in place and saves it by its id, so a rename is a save like any other, and an
-- id that is nobody's business says nothing about how many roles there are. postgres makes
-- them, as it makes an account's. every role that exists gets one; role_members follows.

ALTER TABLE roles ADD COLUMN uid uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE role_members ADD COLUMN role_uid uuid;
UPDATE role_members rm SET role_uid = r.uid FROM roles r WHERE r.id = rm.role_id;
ALTER TABLE role_members ALTER COLUMN role_uid SET NOT NULL;

-- the counter goes. dropping the column drops the keys on it: role_members' primary key and
-- its foreign key first, then roles' own, which nothing points at by then
ALTER TABLE role_members DROP COLUMN role_id;
ALTER TABLE roles DROP COLUMN id;

ALTER TABLE roles RENAME COLUMN uid TO id;
ALTER TABLE role_members RENAME COLUMN role_uid TO role_id;

ALTER TABLE roles ADD PRIMARY KEY (id);
ALTER TABLE role_members ADD PRIMARY KEY (role_id, user_id);
ALTER TABLE role_members ADD FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;
