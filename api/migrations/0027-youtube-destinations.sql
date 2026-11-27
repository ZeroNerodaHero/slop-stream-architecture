ALTER TABLE stream_destinations DROP CONSTRAINT stream_destinations_platform_check;
ALTER TABLE stream_destinations ADD CONSTRAINT stream_destinations_platform_check CHECK (platform IN ('twitch', 'kick', 'youtube', 'custom'));
