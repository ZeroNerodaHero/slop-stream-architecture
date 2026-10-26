-- accounts, and the session a go-live opens. a name with password_hash is a login.

CREATE TABLE streamers (
    name text PRIMARY KEY,
    bio text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    password_hash text,
    created_at timestamptz NOT NULL DEFAULT now(),
    avatar bytea,
    avatar_at timestamptz,
    status text NOT NULL DEFAULT 'online'
);

CREATE TABLE sessions (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    token bigint NOT NULL DEFAULT (floor(random() * 9007199254740991))::bigint,
    verified boolean NOT NULL DEFAULT false,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);

CREATE INDEX sessions_name_started_idx ON sessions (name, started_at DESC);

CREATE TABLE logins (
    token_hash bytea PRIMARY KEY,
    name text NOT NULL REFERENCES streamers(name) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX logins_name_idx ON logins (name);
