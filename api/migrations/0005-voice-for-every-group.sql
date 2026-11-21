-- Every server has a voice channel (voice phase 2). Additive: rows only.
--
-- A new group is made with `general` and a voice channel called `voice` (groups.rs). Each older
-- group with no voice channel gets one here, after its last channel, made by its maker. Its name
-- is `voice`, or `voice-1`, `voice-2`... when a text channel already has that name. A group that
-- has a voice channel is left alone, so running it twice adds nothing. `bot` is no server and
-- gets none.

INSERT INTO channels (server, name, about, created_by_id, position, kind)
SELECT g.name, free.name, '', g.created_by_id,
       COALESCE((SELECT max(c.position) FROM channels c WHERE c.server = g.name), -1) + 1, 'voice'
FROM groups g
CROSS JOIN LATERAL (
    SELECT n.name FROM (
        SELECT 'voice' AS name, 0 AS i
        UNION ALL SELECT 'voice-' || i, i FROM generate_series(1, 20) AS i
    ) n
    WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.server = g.name AND c.name = n.name)
    ORDER BY n.i
    LIMIT 1
) free
WHERE g.name <> 'bot'
  AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.server = g.name AND c.kind = 'voice')
ON CONFLICT DO NOTHING;
