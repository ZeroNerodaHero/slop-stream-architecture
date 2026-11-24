CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE streamers (
    name text NOT NULL,
    bio text DEFAULT '' NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL,
    password_hash text,
    created_at timestamptz DEFAULT now() NOT NULL,
    avatar bytea,
    avatar_at timestamptz,
    status text DEFAULT 'online' NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    renamed_at timestamptz,
    offline_at timestamptz,
    offline_note text DEFAULT '' NOT NULL,
    socials jsonb DEFAULT '{"size": "medium", "links": [], "layout": "row"}'::jsonb NOT NULL,
    about text DEFAULT '' NOT NULL,
    notify jsonb DEFAULT '{}'::jsonb NOT NULL,
    about_page jsonb DEFAULT '{"blocks": []}'::jsonb NOT NULL,
    PRIMARY KEY (name)
);
CREATE UNIQUE INDEX streamers_id_idx ON streamers (id);
CREATE INDEX streamers_name_trgm_idx ON streamers USING gin (name gin_trgm_ops);

CREATE TABLE groups (
    name text NOT NULL,
    badge text NOT NULL,
    color text NOT NULL,
    about text DEFAULT '' NOT NULL,
    created_by text,
    created_at timestamptz DEFAULT now() NOT NULL,
    created_by_id uuid,
    icon_at timestamptz,
    banner_at timestamptz,
    public boolean DEFAULT true NOT NULL,
    title text,
    tag integer,
    member_order text DEFAULT 'name' NOT NULL,
    owner_role text DEFAULT 'owner' NOT NULL,
    PRIMARY KEY (name),
    FOREIGN KEY (created_by) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE SET NULL,
    FOREIGN KEY (created_by_id) REFERENCES streamers(id) ON DELETE SET NULL
);

CREATE TABLE about_files (
    name text NOT NULL,
    id bigint NOT NULL,
    kind text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (name, id)
);

CREATE TABLE admin_pins (
    name text NOT NULL,
    user_id uuid NOT NULL,
    pinned_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (name),
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE bans (
    group_name text NOT NULL,
    user_id uuid NOT NULL,
    by_id uuid,
    reason text DEFAULT '' NOT NULL,
    banned_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (group_name, user_id),
    FOREIGN KEY (by_id) REFERENCES streamers(id) ON DELETE SET NULL,
    FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE channels (
    server text NOT NULL,
    name text NOT NULL,
    about text DEFAULT '' NOT NULL,
    created_by_id uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    cooldown integer DEFAULT 0 NOT NULL,
    PRIMARY KEY (server, name),
    FOREIGN KEY (created_by_id) REFERENCES streamers(id) ON DELETE SET NULL,
    FOREIGN KEY (server) REFERENCES groups(name) ON DELETE CASCADE
);

CREATE TABLE channel_mutes (
    user_id uuid NOT NULL,
    server text NOT NULL,
    channel text NOT NULL,
    muted_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, server, channel),
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE chat_images (
    id uuid NOT NULL,
    mime text NOT NULL,
    created_by uuid,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (created_by) REFERENCES streamers(id) ON DELETE SET NULL
);

CREATE TABLE chat_lines (
    room text NOT NULL,
    id text NOT NULL,
    at timestamptz NOT NULL,
    seq bigint NOT NULL,
    speaker text NOT NULL,
    user_id uuid,
    text text NOT NULL,
    streamer boolean NOT NULL,
    verified boolean NOT NULL,
    badges jsonb DEFAULT '[]'::jsonb NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
    image text,
    has_link boolean GENERATED ALWAYS AS ((text ~* '(^|[^[:alnum:]])(https?://|www\.)[^[:space:]]')) STORED,
    PRIMARY KEY (room, id),
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE SET NULL
);
CREATE INDEX chat_lines_image_idx ON chat_lines (room, at, seq) WHERE (image IS NOT NULL);
CREATE INDEX chat_lines_link_idx ON chat_lines (room, at, seq) WHERE has_link;
CREATE INDEX chat_lines_room_idx ON chat_lines (room, at, seq);
CREATE INDEX chat_lines_search_idx ON chat_lines USING gin (search);
CREATE INDEX chat_lines_user_idx ON chat_lines (user_id, room, at, seq);

CREATE TABLE deploys (
    id bigserial NOT NULL,
    release text NOT NULL,
    commit text DEFAULT '' NOT NULL,
    deployed_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE dm_reads (
    reader_id uuid NOT NULL,
    peer_id uuid NOT NULL,
    last_read_id bigint NOT NULL,
    read_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (reader_id, peer_id),
    FOREIGN KEY (peer_id) REFERENCES streamers(id) ON DELETE CASCADE,
    FOREIGN KEY (reader_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE dms (
    id bigserial NOT NULL,
    from_id uuid NOT NULL,
    to_id uuid NOT NULL,
    text text NOT NULL,
    sent_at timestamptz DEFAULT now() NOT NULL,
    image text,
    CONSTRAINT dms_check CHECK ((from_id <> to_id)),
    PRIMARY KEY (id),
    FOREIGN KEY (from_id) REFERENCES streamers(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX dms_from_idx ON dms (from_id, id DESC);
CREATE INDEX dms_thread_idx ON dms (LEAST(from_id, to_id), GREATEST(from_id, to_id), id DESC);
CREATE INDEX dms_to_idx ON dms (to_id, id DESC);

CREATE TABLE follows (
    follower_id uuid NOT NULL,
    followed_id uuid NOT NULL,
    followed_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT follows_check CHECK ((follower_id <> followed_id)),
    PRIMARY KEY (follower_id, followed_id),
    FOREIGN KEY (followed_id) REFERENCES streamers(id) ON DELETE CASCADE,
    FOREIGN KEY (follower_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX follows_followed_idx ON follows (followed_id, followed_at DESC);

CREATE TABLE held_names (
    name text NOT NULL,
    user_id uuid NOT NULL,
    until timestamptz NOT NULL,
    PRIMARY KEY (name),
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE logins (
    token_hash bytea NOT NULL,
    name text NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    last_seen timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz NOT NULL,
    user_id uuid,
    PRIMARY KEY (token_hash),
    FOREIGN KEY (name) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX logins_name_idx ON logins (name);
CREATE INDEX logins_user_idx ON logins (user_id);

CREATE TABLE memberships (
    name text NOT NULL,
    group_name text NOT NULL,
    joined_at timestamptz DEFAULT now() NOT NULL,
    user_id uuid,
    owner boolean DEFAULT false NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    PRIMARY KEY (name, group_name),
    FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE,
    FOREIGN KEY (name) REFERENCES streamers(name) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX memberships_group_idx ON memberships (group_name);
CREATE UNIQUE INDEX memberships_one_primary_idx ON memberships (user_id) WHERE is_primary;
CREATE UNIQUE INDEX memberships_user_group_idx ON memberships (user_id, group_name);

CREATE TABLE notifications (
    id bigserial NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    actor_id uuid NOT NULL,
    session bigint,
    text text DEFAULT '' NOT NULL,
    at timestamptz DEFAULT now() NOT NULL,
    read_at timestamptz,
    room text,
    PRIMARY KEY (id),
    FOREIGN KEY (actor_id) REFERENCES streamers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE oauth_identities (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    email text,
    created_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT oauth_identities_provider_check CHECK ((provider ~ '^[a-z0-9_]{1,32}$')),
    UNIQUE (provider, provider_user_id),
    UNIQUE (user_id, provider),
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

CREATE TABLE roles (
    group_name text NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    perms integer DEFAULT 0 NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cooldown integer DEFAULT 0 NOT NULL,
    UNIQUE (group_name, name),
    PRIMARY KEY (id),
    FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE
);

CREATE TABLE channel_roles (
    server text NOT NULL,
    channel text NOT NULL,
    role_id uuid NOT NULL,
    PRIMARY KEY (server, channel, role_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX channel_roles_role_idx ON channel_roles (role_id);

CREATE TABLE role_members (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    PRIMARY KEY (role_id, user_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);
CREATE INDEX role_members_user_idx ON role_members (user_id);

CREATE TABLE sessions (
    id bigserial NOT NULL,
    name text NOT NULL,
    token bigint DEFAULT (floor((random() * ('9007199254740991'::bigint)::double precision)))::bigint NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    started_at timestamptz DEFAULT now() NOT NULL,
    ended_at timestamptz,
    user_id uuid,
    last_beat_at timestamptz,
    ended_by text,
    PRIMARY KEY (id)
);
CREATE INDEX sessions_name_started_idx ON sessions (name, started_at DESC);
CREATE INDEX sessions_user_started_idx ON sessions (user_id, started_at DESC) WHERE (user_id IS NOT NULL);

CREATE TABLE stream_assets (
    name text NOT NULL,
    id bigint NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (name, id)
);

CREATE TABLE stream_thumbs (
    name text NOT NULL,
    id bigint NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (name, id)
);

CREATE TABLE timeouts (
    group_name text NOT NULL,
    user_id uuid NOT NULL,
    until timestamptz NOT NULL,
    by_id uuid,
    PRIMARY KEY (group_name, user_id),
    FOREIGN KEY (by_id) REFERENCES streamers(id) ON DELETE SET NULL,
    FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES streamers(id) ON DELETE CASCADE
);

INSERT INTO groups (name, badge, color, about)
    VALUES ('bot', 'BOT', '#5865f2', 'automatic. the fake streams'' pretend chatters, and any chat socket that says it is one. nobody joins it.');
