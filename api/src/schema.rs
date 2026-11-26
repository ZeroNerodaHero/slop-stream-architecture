use sqlx::postgres::PgPool;
use sqlx::{Connection, Executor};

const SCHEMA: &str = include_str!("../schema.sql");

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001-channel-pins", include_str!("../migrations/0001-channel-pins.sql")),
    ("0002-replies", include_str!("../migrations/0002-replies.sql")),
    ("0003-reactions", include_str!("../migrations/0003-reactions.sql")),
    ("0004-voice-channels", include_str!("../migrations/0004-voice-channels.sql")),
    ("0005-voice-for-every-group", include_str!("../migrations/0005-voice-for-every-group.sql")),
    ("0006-channel-home", include_str!("../migrations/0006-channel-home.sql")),
    ("0007-jannies", include_str!("../migrations/0007-jannies.sql")),
    ("0008-oauth-identity-shown", include_str!("../migrations/0008-oauth-identity-shown.sql")),
    ("0009-chat-welcome", include_str!("../migrations/0009-chat-welcome.sql")),
    ("0010-timeout-reason", include_str!("../migrations/0010-timeout-reason.sql")),
    ("0011-group-emotes", include_str!("../migrations/0011-group-emotes.sql")),
    ("0012-chat-videos", include_str!("../migrations/0012-chat-videos.sql")),
    ("0013-media-context", include_str!("../migrations/0013-media-context.sql")),
    ("0014-stream-analytics", include_str!("../migrations/0014-stream-analytics.sql")),
    ("0015-image-moderation", include_str!("../migrations/0015-image-moderation.sql")),
    ("0016-people-index", include_str!("../migrations/0016-people-index.sql")),
    ("0017-test-streamers", include_str!("../migrations/0017-test-streamers.sql")),
    ("0018-mentions", include_str!("../migrations/0018-mentions.sql")),
    ("0019-chat-audio", include_str!("../migrations/0019-chat-audio.sql")),
];

pub(crate) async fn ensure(db: &PgPool) -> anyhow::Result<()> {
    let mut conn = db.acquire().await?;
    conn.execute("SELECT pg_advisory_lock(839201)").await?;
    let applied = apply(&mut conn).await;
    let unlocked = conn.execute("SELECT pg_advisory_unlock(839201)").await;
    applied?;
    unlocked?;
    Ok(())
}

async fn apply(conn: &mut sqlx::PgConnection) -> anyhow::Result<()> {
    let there: bool =
        sqlx::query_scalar("SELECT to_regclass('public.streamers') IS NOT NULL").fetch_one(&mut *conn).await?;
    if !there {
        let mut tx = conn.begin().await?;
        tx.execute(SCHEMA).await.map_err(|e| anyhow::anyhow!("schema.sql: {e}"))?;
        tx.commit().await?;
        log::info!("empty database: schema.sql applied");
    }
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now() NOT NULL)",
    )
    .await?;
    let done: Vec<String> = sqlx::query_scalar("SELECT name FROM schema_migrations").fetch_all(&mut *conn).await?;
    for (name, sql) in MIGRATIONS {
        if done.iter().any(|d| d == name) {
            continue;
        }
        let mut tx = conn.begin().await?;
        tx.execute(*sql).await.map_err(|e| anyhow::anyhow!("migration {name}: {e}"))?;
        sqlx::query("INSERT INTO schema_migrations (name) VALUES ($1)").bind(*name).execute(&mut *tx).await?;
        tx.commit().await?;
        log::info!("migration {name} applied");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_makes_the_table_it_is_checked_by() {
        assert!(SCHEMA.contains("CREATE TABLE streamers ("));
    }

    #[test]
    fn migrations_are_numbered_in_order_and_named_once() {
        let names: Vec<&str> = MIGRATIONS.iter().map(|(n, _)| *n).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names, sorted, "MIGRATIONS must be in name order with no repeats");
        for n in names {
            assert!(n.len() > 5 && n[..4].bytes().all(|b| b.is_ascii_digit()) && &n[4..5] == "-", "{n}: NNNN-what");
        }
    }
}
