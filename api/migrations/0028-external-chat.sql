ALTER TABLE streamers ADD COLUMN external_chat text NOT NULL DEFAULT 'everyone' CHECK (external_chat IN ('off', 'studio', 'everyone'));
