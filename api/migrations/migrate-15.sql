-- a group's picture and banner, an owner, custom roles, and bans.
-- the maker of a group that already exists becomes its owner.

ALTER TABLE groups ADD COLUMN icon_at timestamptz;
ALTER TABLE groups ADD COLUMN banner_at timestamptz;

ALTER TABLE memberships ADD COLUMN owner boolean NOT NULL DEFAULT false;

UPDATE memberships m SET owner = true
FROM groups g
WHERE g.name = m.group_name AND g.created_by_id = m.user_id;

CREATE TABLE roles (
    id bigserial PRIMARY KEY,
    group_name text NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    name text NOT NULL,
    color text NOT NULL,
    perms integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (group_name, name)
);

CREATE TABLE role_members (
    role_id bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, user_id)
);

CREATE INDEX role_members_user_idx ON role_members (user_id);

CREATE TABLE bans (
    group_name text NOT NULL REFERENCES groups(name) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    by_id uuid REFERENCES streamers(id) ON DELETE SET NULL,
    reason text NOT NULL DEFAULT '',
    banned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_name, user_id)
);
