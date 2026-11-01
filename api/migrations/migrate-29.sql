-- a channel's cooldown (docs/groups.md): seconds a member waits between their lines in that channel,
-- 0 (off) unless the channels power says otherwise. beside a role's cooldown, which is the holder's
-- across the server: a line waits for whichever is longer. the owners, the channels power and a site
-- admin wait for nobody.
ALTER TABLE channels ADD COLUMN cooldown integer NOT NULL DEFAULT 0;
