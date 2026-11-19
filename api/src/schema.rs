//! The database is one file, `api/schema.sql`. At boot the api applies it to an empty
//! database, in one transaction, and leaves a database that already has it alone. There
//! is no version table and no migrations: a change to the tables is an edit of that file,
//! and an existing database is reset to pick it up (fine while there are no real users).
//!
//! "Empty" is "no `streamers` table". The whole file runs in one transaction, so a database
//! has either all of it or none of it, and a boot that dies halfway leaves nothing behind.

use sqlx::postgres::PgPool;
use sqlx::{Connection, Executor};

const SCHEMA: &str = include_str!("../schema.sql");

/// Apply `schema.sql` when the database has no tables yet. The chat process does not call this.
pub(crate) async fn ensure(db: &PgPool) -> anyhow::Result<()> {
    let mut conn = db.acquire().await?;
    // two api processes booting at once: the second waits, then finds the tables there.
    // held on this connection, released when it is unlocked or closes
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
    if there {
        return Ok(());
    }
    let mut tx = conn.begin().await?;
    tx.execute(SCHEMA).await.map_err(|e| anyhow::anyhow!("schema.sql: {e}"))?;
    tx.commit().await?;
    log::info!("empty database: schema.sql applied");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_makes_the_table_it_is_checked_by() {
        assert!(SCHEMA.contains("CREATE TABLE streamers ("));
    }
}
