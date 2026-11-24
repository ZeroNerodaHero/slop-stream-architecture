use std::collections::HashSet;

use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use sqlx::PgPool;

use crate::{ApiError, PasswordQuery};

pub(crate) const HEADER: &str = "x-dummy-password";

macro_rules! shown_sql {
    ($row:literal, $hide:literal) => {
        concat!("NOT (", $hide, "::boolean AND ", $row, ".is_test)")
    };
}
pub(crate) use shown_sql;

pub(crate) fn hide_from(raw: Option<&str>) -> bool {
    raw.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true"))
}

pub(crate) fn hide_from_env() -> bool {
    let hide = hide_from(std::env::var("HIDE_TEST_STREAMERS").ok().as_deref());
    if hide {
        log::info!("HIDE_TEST_STREAMERS: test streamers are left out of every list and refused go-live");
    }
    hide
}

pub(crate) fn shown(hide: bool, is_test: bool) -> bool {
    !(hide && is_test)
}

fn same_secret(given: &[u8], want: &[u8]) -> bool {
    let mut diff = given.len() ^ want.len();
    for i in 0..given.len().max(want.len()) {
        diff |= usize::from(given.get(i).copied().unwrap_or(0) ^ want.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

pub(crate) fn secret_ok(want: Option<&str>, given: Option<&str>) -> bool {
    matches!((want, given), (Some(want), Some(given)) if same_secret(given.as_bytes(), want.as_bytes()))
}

pub(crate) fn given_secret(headers: &HeaderMap, query: Option<String>) -> Option<String> {
    headers.get(HEADER).and_then(|v| v.to_str().ok()).map(str::to_owned).or(query)
}

fn named_by_path(matched: &str) -> bool {
    matched == "/api/streamers/{name}" || matched.starts_with("/api/streamers/{name}/") || matched.starts_with("/api/streams/{name}/")
}

pub(crate) fn skips_limits(prefix: &str, want: Option<&str>, matched: &str, name: &str, given: Option<&str>) -> bool {
    !prefix.is_empty() && named_by_path(matched) && name.starts_with(prefix) && secret_ok(want, given)
}

pub(crate) async fn mark(db: &PgPool, name: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO streamers (name, is_test) VALUES ($1, true)
         ON CONFLICT (name) DO UPDATE SET is_test = true WHERE NOT streamers.is_test",
    )
    .bind(name)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn hidden(db: &PgPool, hide: bool, name: &str) -> Result<bool, sqlx::Error> {
    if !hide {
        return Ok(false);
    }
    let is_test: Option<bool> = sqlx::query_scalar("SELECT is_test FROM streamers WHERE name = $1").bind(name).fetch_optional(db).await?;
    Ok(!shown(hide, is_test.unwrap_or(false)))
}

pub(crate) async fn tests_among(db: &PgPool, names: &[String]) -> Result<HashSet<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT name FROM streamers WHERE name = ANY($1) AND is_test").bind(names).fetch_all(db).await?;
    Ok(rows.into_iter().collect())
}

pub(crate) fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such streamer")
}

pub(crate) fn refused() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "test streamers are hidden here")
}

pub(crate) struct DummySecret(pub(crate) Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for DummySecret {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        let Query(q) = Query::<PasswordQuery>::from_request_parts(parts, state).await?;
        Ok(DummySecret(given_secret(&parts.headers, q.password)))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use uuid::Uuid;

    use super::*;
    use crate::auth::tests::{row, test_db};

    #[test]
    fn hiding_is_off_unless_asked() {
        assert!(!hide_from(None));
        assert!(!hide_from(Some("")));
        assert!(!hide_from(Some("0")));
        assert!(!hide_from(Some("false")));
        assert!(!hide_from(Some("yes")));
        assert!(hide_from(Some("1")));
        assert!(hide_from(Some("true")));
        assert!(hide_from(Some(" TRUE ")));
    }

    #[test]
    fn only_a_test_streamer_with_hiding_on_is_left_out() {
        assert!(shown(false, false));
        assert!(shown(false, true));
        assert!(shown(true, false));
        assert!(!shown(true, true));
    }

    #[test]
    fn the_sql_fragment_names_the_row_and_the_switch() {
        assert_eq!(shown_sql!("s", "$3"), "NOT ($3::boolean AND s.is_test)");
        assert_eq!(shown_sql!("a", "$2"), "NOT ($2::boolean AND a.is_test)");
    }

    #[test]
    fn the_secret_must_match_exactly() {
        assert!(secret_ok(Some("hunter2"), Some("hunter2")));
        assert!(!secret_ok(Some("hunter2"), Some("hunter")));
        assert!(!secret_ok(Some("hunter2"), Some("hunter22")));
        assert!(!secret_ok(Some("hunter2"), Some("Hunter2")));
        assert!(!secret_ok(Some("hunter2"), Some("")));
        assert!(!secret_ok(Some("hunter2"), None));
        assert!(!secret_ok(None, Some("hunter2")));
        assert!(!secret_ok(None, None));
    }

    #[test]
    fn the_header_wins_and_the_query_still_counts() {
        let mut h = HeaderMap::new();
        assert_eq!(given_secret(&h, None), None);
        assert_eq!(given_secret(&h, Some("q".into())).as_deref(), Some("q"));
        h.insert(HEADER, HeaderValue::from_static("h"));
        assert_eq!(given_secret(&h, None).as_deref(), Some("h"));
        assert_eq!(given_secret(&h, Some("q".into())).as_deref(), Some("h"));
        let mut cased = HeaderMap::new();
        cased.insert("X-Dummy-Password", HeaderValue::from_static("h"));
        assert_eq!(given_secret(&cased, None).as_deref(), Some("h"));
    }

    #[test]
    fn the_limits_are_skipped_only_for_a_dummy_name_with_the_secret() {
        let want = Some("s3cret");
        let ok = Some("s3cret");
        assert!(skips_limits("dummy-", want, "/api/streamers/{name}", "dummy-mango", ok));
        assert!(skips_limits("dummy-", want, "/api/streamers/{name}/avatar", "dummy-mango", ok));
        assert!(skips_limits("dummy-", want, "/api/streamers/{name}/about-page", "dummy-mango", ok));
        assert!(skips_limits("dummy-", want, "/api/streams/{name}/go-live", "dummy-mango", ok));
        assert!(!skips_limits("dummy-", want, "/api/streams/{name}/go-live", "billy", ok));
        assert!(!skips_limits("dummy-", want, "/api/streamers/{name}", "billy", ok));
        assert!(!skips_limits("dummy-", want, "/api/streams/{name}/go-live", "dummy-mango", Some("wrong")));
        assert!(!skips_limits("dummy-", want, "/api/streams/{name}/go-live", "dummy-mango", None));
        assert!(!skips_limits("dummy-", None, "/api/streams/{name}/go-live", "dummy-mango", ok));
        assert!(!skips_limits("dummy-", want, "/api/login", "", ok));
        assert!(!skips_limits("dummy-", want, "/api/groups/{group}/join", "dummy-mango", ok));
        assert!(!skips_limits("dummy-", want, "/api/dm/{name}", "dummy-mango", ok));
        assert!(!skips_limits("dummy-", want, "/api/chat-images", "", ok));
        assert!(!skips_limits("", want, "/api/streamers/{name}", "billy", ok));
    }

    #[tokio::test]
    #[ignore]
    async fn a_dummy_write_marks_the_row_and_hiding_reads_it() {
        let pool = test_db().await;
        let run = std::process::id();
        let dummy = format!("dummy-t{run}");
        let human = format!("human-t{run}");
        assert!(!hidden(&pool, true, &dummy).await.unwrap(), "no row is not a test streamer");
        mark(&pool, &dummy).await.unwrap();
        mark(&pool, &dummy).await.unwrap();
        let (is_test, hash): (bool, Option<String>) =
            sqlx::query_as("SELECT is_test, password_hash FROM streamers WHERE name = $1").bind(&dummy).fetch_one(&pool).await.unwrap();
        assert!(is_test);
        assert_eq!(hash, None);
        assert!(hidden(&pool, true, &dummy).await.unwrap());
        assert!(!hidden(&pool, false, &dummy).await.unwrap());

        let id: Uuid = row(&pool, &human, Some("h")).await;
        assert!(!hidden(&pool, true, &human).await.unwrap());
        let found = tests_among(&pool, &[dummy.clone(), human.clone(), format!("nobody-t{run}")]).await.unwrap();
        assert_eq!(found, HashSet::from([dummy.clone()]));

        sqlx::query("DELETE FROM streamers WHERE id = $1 OR name = $2").bind(id).bind(&dummy).execute(&pool).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn mark_keeps_an_existing_rows_fields() {
        let pool = test_db().await;
        let dummy = format!("dummy-k{}", std::process::id());
        sqlx::query("INSERT INTO streamers (name, bio) VALUES ($1, 'kept')").bind(&dummy).execute(&pool).await.unwrap();
        mark(&pool, &dummy).await.unwrap();
        let (is_test, bio): (bool, String) = sqlx::query_as("SELECT is_test, bio FROM streamers WHERE name = $1").bind(&dummy).fetch_one(&pool).await.unwrap();
        assert!(is_test);
        assert_eq!(bio, "kept");
        sqlx::query("DELETE FROM streamers WHERE name = $1").bind(&dummy).execute(&pool).await.unwrap();
    }
}
