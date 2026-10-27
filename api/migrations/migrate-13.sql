-- the deploys: one row per ./scripts/deploy.sh run that ended well, written by `api release`
-- (api/src/release.rs) once /api/health has answered 200. `release` is the tag the github
-- action puts on every push to main it built images for, v<n> (v<n>+<commit> for a tree past
-- the last one); `commit` is the checkout that run deployed. the newest row is what /api/health
-- says under `version` and `deployed_at`. a log: nothing here is updated or removed.

CREATE TABLE deploys (
    id bigserial PRIMARY KEY,
    release text NOT NULL,
    commit text NOT NULL DEFAULT '',
    deployed_at timestamptz NOT NULL DEFAULT now()
);
