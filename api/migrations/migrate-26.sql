-- a channel kept to roles (docs/groups.md): a row for each role that unlocks it. a channel with no
-- row is everyone's. one with rows is seen by the holders of those roles, the owners, the channels
-- power and a site admin, and by nobody else: not in the room, the messages, the chat sockets, the
-- history or the inbox. general is never kept. a row goes with its role, and with its channel
-- (and follows the channel's name).
CREATE TABLE channel_roles (
    server text NOT NULL,
    channel text NOT NULL,
    role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server, channel, role_id),
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX channel_roles_role_idx ON channel_roles (role_id);
