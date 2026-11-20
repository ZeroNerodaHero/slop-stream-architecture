-- Reactions (docs/chat.md "reactions", docs/dms.md). Additive: two new tables, nothing else touched.
--
-- One row is one login's one emoji on one line: the primary key is the "once per emoji per person"
-- rule. The emoji is one of the short list the api allows (reactions.rs `EMOJIS`); the api also keeps
-- a line to 20 different ones. Who reacted is an account, read back under the name it has now.

-- A room's line (a stream's chat, a group's channel) by its room and its redis stream id, the
-- `chat_lines` key. No foreign key: a room's line may live in redis alone (`CHAT_PERSIST` off), and
-- a reaction on a line that is gone is never read.
CREATE TABLE chat_reactions (
    room text NOT NULL,
    line_id text NOT NULL,
    emoji text NOT NULL,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (room, line_id, emoji, user_id)
);

-- A direct message's line, which goes with it.
CREATE TABLE dm_reactions (
    dm_id bigint NOT NULL REFERENCES dms(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    user_id uuid NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (dm_id, emoji, user_id)
);
