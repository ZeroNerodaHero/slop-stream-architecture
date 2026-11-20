-- Replies (docs/chat.md "replies", docs/dms.md). Additive: two nullable columns, nothing rewritten.
--
-- A room's line (a stream's chat, a group's channel) keeps what it answers as it was said, the
-- same json the redis entry carries in `r` (`chat::Reply`: the id, who said it, the start of its
-- words), so the quote outlives the room's stream trimming the line it points at.
ALTER TABLE chat_lines ADD COLUMN reply jsonb;

-- A direct message names the line of its thread it answers. No foreign key: the quote is read
-- by a join, and a line that is not there any more reads as gone rather than unlinking the reply.
ALTER TABLE dms ADD COLUMN reply_to bigint;
