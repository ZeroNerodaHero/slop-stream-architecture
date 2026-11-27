DELETE FROM stream_destinations d
USING oauth_identities o
WHERE d.external_id IS NOT NULL
  AND o.provider = d.platform
  AND o.provider_user_id = d.external_id
  AND o.user_id <> d.user_id;

DELETE FROM stream_destinations d
USING stream_destinations e
WHERE d.external_id IS NOT NULL
  AND e.platform = d.platform
  AND e.external_id = d.external_id
  AND (e.created_at, e.id) < (d.created_at, d.id);

CREATE UNIQUE INDEX stream_destinations_one_owner ON stream_destinations (platform, external_id) WHERE external_id IS NOT NULL;

CREATE FUNCTION stream_account_one_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    kind text;
    ext text;
    other uuid;
BEGIN
    IF TG_TABLE_NAME = 'stream_destinations' THEN
        IF NEW.external_id IS NULL THEN
            RETURN NEW;
        END IF;
        kind := NEW.platform;
        ext := NEW.external_id;
    ELSE
        kind := NEW.provider;
        ext := NEW.provider_user_id;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('stream-account:' || kind || ':' || ext, 0));
    IF TG_TABLE_NAME = 'stream_destinations' THEN
        SELECT user_id INTO other FROM oauth_identities WHERE provider = kind AND provider_user_id = ext AND user_id <> NEW.user_id LIMIT 1;
    ELSE
        SELECT user_id INTO other FROM stream_destinations WHERE platform = kind AND external_id = ext AND user_id <> NEW.user_id LIMIT 1;
    END IF;
    IF other IS NOT NULL THEN
        RAISE EXCEPTION 'that % account belongs to another login', kind USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER stream_destinations_one_owner BEFORE INSERT OR UPDATE OF user_id, platform, external_id ON stream_destinations
    FOR EACH ROW EXECUTE FUNCTION stream_account_one_owner();

CREATE TRIGGER oauth_identities_one_owner BEFORE INSERT OR UPDATE OF user_id, provider, provider_user_id ON oauth_identities
    FOR EACH ROW EXECUTE FUNCTION stream_account_one_owner();
