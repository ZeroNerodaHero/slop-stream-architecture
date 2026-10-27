//! The release this box runs. The github action (`.github/workflows/images.yml`) numbers every
//! run that pushed the four images: `v1`, `v2`, ..., one more than the highest tag so far, put
//! on the commit as a git tag and on the images as `stream-<x>:v<n>` beside `:<commit>`.
//! `./scripts/deploy.sh` works out which release its tree is (the highest `v<n>` reachable
//! from HEAD; `v<n>+<commit>` when the images are newer than that tag) and, once `/api/health`
//! has answered 200, runs `api release <version> <commit>`: one row in `deploys`
//! (`migrate-13.sql`) per run that ended well. The newest row is what `/api/health` says under
//! `version` and `deployed_at`.
//!
//! In the database, not the environment, on purpose: a release that moved only the pages
//! would otherwise wait for the api container to be recreated before it was reported, and
//! a restart would lose it. See docs/debugging.md, "health".

use chrono::{DateTime, Utc};
use sqlx::PgPool;

/// The newest deploy: its release and when. None on a box no deploy.sh run has finished on.
pub(crate) async fn current(db: &PgPool) -> Result<Option<(String, DateTime<Utc>)>, sqlx::Error> {
    sqlx::query_as("SELECT release, deployed_at FROM deploys ORDER BY id DESC LIMIT 1").fetch_optional(db).await
}

/// `api release <version> [commit]`: one more row. The version is `v<n>`, or `v<n>+<commit>`
/// for a tree past the last tag (deploy.sh says which); any short printable word is taken.
pub(crate) async fn record(db: &PgPool, version: &str, commit: &str) -> anyhow::Result<()> {
    let version = version.trim();
    anyhow::ensure!(
        !version.is_empty() && version.len() <= 64 && version.chars().all(|c| c.is_ascii_graphic()),
        "bad version: one short word, like v12"
    );
    let commit = commit.trim();
    anyhow::ensure!(commit.len() <= 64 && commit.chars().all(|c| c.is_ascii_hexdigit()), "bad commit: hex, or nothing");
    sqlx::query("INSERT INTO deploys (release, commit) VALUES ($1, $2)").bind(version).bind(commit).execute(db).await?;
    println!("{version}");
    Ok(())
}
