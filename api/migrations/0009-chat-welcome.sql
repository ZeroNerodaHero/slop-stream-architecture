-- The chat welcome (docs/chat.md): the line the bot `Eques` says, on the viewer's screen only, when
-- they open a stream's chat. The streamer may change the words or turn it off. Additive: two columns.
ALTER TABLE streamers
    ADD COLUMN welcome_on boolean DEFAULT true NOT NULL,
    ADD COLUMN welcome text DEFAULT 'welcome to the chat!' NOT NULL;
