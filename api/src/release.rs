use chrono::{DateTime, Utc};
use sqlx::PgPool;

pub(crate) async fn current(db: &PgPool) -> Result<Option<(String, DateTime<Utc>)>, sqlx::Error> {
    sqlx::query_as("SELECT release, deployed_at FROM deploys ORDER BY id DESC LIMIT 1").fetch_optional(db).await
}

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
