//! A group channel's pinned lines (docs/groups.md "pins"). Group channels only: a stream's chat
//! and a dm have none. A pin is (channel, line, who pinned it, when), at most `MAX_PINS` a
//! channel, and keeps the line as it was said (`channel_pins.line`), so a pin outlives the
//! room's stream trimming the line. The channels power pins and unpins (an owner and a site
//! admin always may: `group_mod::allows`); whoever sees the channel reads its pins. Each change is
//! a `pin` or `unpin` fact on the group's topic, with the channel and the line's id alone: the
//! topic is everyone's, and a channel kept to roles keeps its words to them.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::Me;
use crate::chat::{with_faces, Line};
use crate::group_mod::{allows, CHANNELS};
use crate::groups::{channel_room, may_see_text, tell};
use crate::{history, ApiError, ApiResult, AppState};

/// How many lines one channel keeps pinned. One more is a 400 until one is unpinned.
pub(crate) const MAX_PINS: i64 = 50;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups/{group}/channels/{channel}/pins", get(list))
        .route("/api/groups/{group}/channels/{channel}/pins/{message}", axum::routing::post(pin).delete(unpin))
}

fn not_logged_in() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "not logged in")
}

fn no_such_channel() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "no such channel")
}

fn is_admin(s: &AppState, user: Option<Uuid>) -> bool {
    user.is_some_and(|id| s.admins.iter().any(|a| a.id == id))
}

/// The server, the channel and its room key, once the channel is there and this viewer sees it
/// (`groups::may_see_text`): a voice channel, or one kept to roles they do not hold, reads
/// `no such channel`.
async fn seen(s: &AppState, group: &str, channel: &str, user: Option<Uuid>) -> Result<(String, String, String), ApiError> {
    let (server, room) = channel_room(&s.db, group, channel).await?;
    let channel = room[server.len() + 1..].to_owned();
    if !may_see_text(&s.db, &server, &channel, user, is_admin(s, user)).await? {
        return Err(no_such_channel());
    }
    Ok((server, channel, room))
}

/// The ids pinned in each of `channels` of `server`, newest pin first: the room's answer
/// carries them (`pins`), so the header's count and the lines' marks need no request.
pub(crate) async fn pinned_ids(db: &PgPool, server: &str, channels: &[String]) -> Result<Map<String, Value>, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT channel, message_id FROM channel_pins WHERE server = $1 AND channel = ANY($2) ORDER BY pinned_at DESC, message_id DESC",
    )
    .bind(server)
    .bind(channels)
    .fetch_all(db)
    .await?;
    let mut out = Map::new();
    for (channel, id) in rows {
        if let Value::Array(ids) = out.entry(channel).or_insert_with(|| Value::Array(Vec::new())) {
            ids.push(Value::String(id));
        }
    }
    Ok(out)
}

/// line, speaker_id, pinned_by (their name now), pinned_at (unix ms)
type PinRow = (Value, Option<Uuid>, Option<String>, i64);

/// The lines as kept, faced as they are now (`with_faces`), each with who pinned it and when.
async fn pins_json(db: &PgPool, rows: Vec<PinRow>) -> Vec<Value> {
    let mut kept: Vec<(Line, Option<String>, i64)> = rows
        .into_iter()
        .filter_map(|(line, speaker, by, at)| {
            let mut line: Line = serde_json::from_value(line).ok()?;
            line.user_id = speaker;
            Some((line, by, at))
        })
        .collect();
    with_faces(db, kept.iter_mut().map(|(line, _, _)| line)).await;
    kept.into_iter()
        .filter_map(|(line, by, at)| {
            let Value::Object(mut out) = serde_json::to_value(line).ok()? else { return None };
            out.insert("pinned_by".into(), json!(by));
            out.insert("pinned_at".into(), json!(at));
            Some(Value::Object(out))
        })
        .collect()
}

const PIN_COLUMNS: &str = "p.line, p.speaker_id, s.name, (EXTRACT(EPOCH FROM p.pinned_at) * 1000)::bigint
                           FROM channel_pins p LEFT JOIN streamers s ON s.id = p.pinned_by";

/// `GET /api/groups/:group/channels/:channel/pins`: the channel's pinned lines, newest pin
/// first, each a chat line as the messages have it plus `pinned_by` (a name, null for an
/// account since gone) and `pinned_at` (unix ms): `{ pins: [...] }`. Whoever sees the channel,
/// logged in or not; 404 `no such channel` for one they do not (or that is not there).
async fn list(State(s): State<AppState>, Path((group, channel)): Path<(String, String)>, Me(me): Me) -> ApiResult {
    let user = me.as_ref().map(|a| a.id);
    let (server, channel, _) = seen(&s, &group, &channel, user).await?;
    let sql = format!("SELECT {PIN_COLUMNS} WHERE p.server = $1 AND p.channel = $2 ORDER BY p.pinned_at DESC, p.message_id DESC");
    let rows: Vec<PinRow> = sqlx::query_as(&sql).bind(&server).bind(&channel).fetch_all(&s.db).await?;
    Ok(Json(json!({ "pins": pins_json(&s.db, rows).await })))
}

/// `POST /api/groups/:group/channels/:channel/pins/:message`: pin the line with that id. The
/// channels power (an owner, a site admin). → the pin, as the list has it; the same when it was
/// pinned already. 401 nobody, 404 `no such channel` (or one this login does not see), 403
/// without the power, 400 `bad id`, 404 `no such line` (not this channel's, or long gone),
/// 400 at `MAX_PINS`. A `pin` fact (`channel`, `id`) to every room open.
async fn pin(State(s): State<AppState>, Path((group, channel, message)): Path<(String, String, String)>, Me(me): Me) -> ApiResult {
    let who = me.ok_or_else(not_logged_in)?;
    let (server, channel, room) = seen(&s, &group, &channel, Some(who.id)).await?;
    if !allows(&s, who.id, &server, CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't pin here"));
    }
    let id = history::stream_id(&message)?;
    let Some(line) = history::line_at(&s.db, &mut s.redis.clone(), &room, &id).await? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "no such line"));
    };
    let speaker = line.user_id;
    let kept = serde_json::to_value(&line).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut tx = s.db.begin().await?;
    // one pin at a time per channel, so two at the cap cannot both get in
    let there: Option<i32> = sqlx::query_scalar("SELECT 1 FROM channels WHERE server = $1 AND name = $2 AND kind = 'text' FOR UPDATE")
        .bind(&server)
        .bind(&channel)
        .fetch_optional(&mut *tx)
        .await?;
    if there.is_none() {
        return Err(no_such_channel());
    }
    let (count, already): (i64, bool) = sqlx::query_as(
        "SELECT count(*), COALESCE(bool_or(message_id = $3), false) FROM channel_pins WHERE server = $1 AND channel = $2",
    )
    .bind(&server)
    .bind(&channel)
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    if !already {
        if count >= MAX_PINS {
            return Err(ApiError::new(StatusCode::BAD_REQUEST, format!("{MAX_PINS} pins at most: unpin one first")));
        }
        sqlx::query("INSERT INTO channel_pins (server, channel, message_id, line, speaker_id, pinned_by) VALUES ($1, $2, $3, $4, $5, $6)")
            .bind(&server)
            .bind(&channel)
            .bind(&id)
            .bind(&kept)
            .bind(speaker)
            .bind(who.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if !already {
        log::info!("{}: pinned {id} in #{channel} of {server}", who.name);
        tell(&s, &server, "pin", json!({ "channel": channel, "id": id })).await;
    }
    let sql = format!("SELECT {PIN_COLUMNS} WHERE p.server = $1 AND p.channel = $2 AND p.message_id = $3");
    let rows: Vec<PinRow> = sqlx::query_as(&sql).bind(&server).bind(&channel).bind(&id).fetch_all(&s.db).await?;
    let pin = pins_json(&s.db, rows).await.into_iter().next().ok_or_else(no_such_channel)?;
    Ok(Json(pin))
}

/// `DELETE /api/groups/:group/channels/:channel/pins/:message`: unpin it. 204, also when it was
/// not pinned. The channels power; 401, 403, 404 and 400 `bad id` as for a pin. An `unpin`
/// fact (`channel`, `id`) when one went.
async fn unpin(State(s): State<AppState>, Path((group, channel, message)): Path<(String, String, String)>, Me(me): Me) -> Result<StatusCode, ApiError> {
    let who = me.ok_or_else(not_logged_in)?;
    let (server, channel, _) = seen(&s, &group, &channel, Some(who.id)).await?;
    if !allows(&s, who.id, &server, CHANNELS).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "you can't unpin here"));
    }
    let id = history::stream_id(&message)?;
    let gone = sqlx::query("DELETE FROM channel_pins WHERE server = $1 AND channel = $2 AND message_id = $3")
        .bind(&server)
        .bind(&channel)
        .bind(&id)
        .execute(&s.db)
        .await?;
    if gone.rows_affected() > 0 {
        log::info!("{}: unpinned {id} in #{channel} of {server}", who.name);
        tell(&s, &server, "unpin", json!({ "channel": channel, "id": id })).await;
    }
    Ok(StatusCode::NO_CONTENT)
}
