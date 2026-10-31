-- a channel can be renamed (PUT /api/groups/:group/channels/:channel, docs/groups.md). a mute
-- on it follows the name, the way it goes with the channel when the channel is deleted.
ALTER TABLE channel_mutes DROP CONSTRAINT channel_mutes_server_channel_fkey;
ALTER TABLE channel_mutes ADD CONSTRAINT channel_mutes_server_channel_fkey
    FOREIGN KEY (server, channel) REFERENCES channels(server, name) ON DELETE CASCADE ON UPDATE CASCADE;
