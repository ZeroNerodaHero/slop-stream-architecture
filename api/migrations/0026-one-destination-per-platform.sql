DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT d.id, d.user_id, d.platform, d.external_name, d.updated_at
        FROM stream_destinations d
        WHERE EXISTS (
            SELECT 1 FROM stream_destinations e
            WHERE e.user_id = d.user_id AND e.platform = d.platform AND (e.updated_at, e.id) > (d.updated_at, d.id)
        )
    LOOP
        RAISE WARNING 'migration 0026 removes destination % (% %, last connected %) of user %: a newer % is kept', r.id, r.platform, r.external_name, r.updated_at, r.user_id, r.platform;
    END LOOP;
END
$$;

DELETE FROM stream_destinations d
WHERE EXISTS (
    SELECT 1 FROM stream_destinations e
    WHERE e.user_id = d.user_id AND e.platform = d.platform AND (e.updated_at, e.id) > (d.updated_at, d.id)
);

CREATE UNIQUE INDEX stream_destinations_one_per_platform ON stream_destinations (user_id, platform);
