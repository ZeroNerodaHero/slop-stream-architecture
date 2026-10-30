#!/usr/bin/env bash
#
# test.sh — prove the whole thing works, with real browsers.
#
#   ./scripts/test.sh                      the stack on this machine (starts it if it is down)
#   ./scripts/test.sh https://1.2.3.4      a server somewhere else, from this laptop
#   ./scripts/test.sh --all                also the redeploy test (runs ./scripts/deploy.sh api/frontend/video)
#   HEADED=1 ./scripts/test.sh             watch the browsers
#
# Needs node and Google Chrome on the machine running the tests. With a url, that is any
# machine. Without one it is the server itself: regress, redeploy and dummy restart
# containers through docker compose here, and auth and errors read redis and the database.
# A fake camera is used, so nothing is recorded and no permission prompt appears.
# Stream names are fixed (e2etest, r1..r7, rd1, ...): one person at a time per server.
#
# What runs:
#   e2e        go live -> listed on home -> watcher sees frames -> stop -> watcher sees ended
#   dup        a second person on the same name is refused
#   chat       two viewers talk, history survives a reload, 501 chars refused, streamer lines marked
#   auth       sign up, log in, log out, a claimed name is only its owner's, verified chat lines, 429 after 10 tries
#   groups     bot is built in, a login makes a group, another joins and leaves, badges on chat lines, a bot's lines wear BOT and the panel hides them, only the maker deletes, the groups tab;
#              the pictures are the owner's whatever the roles say (no remove) and a role reaches only the powers its holder has;
#              the room is one answer (channels, live, the roster for members, the bans) plus the last lines of every channel, a watcher of group:<name> hears a channel
#              added and deleted, the server's one chat socket carries every channel's lines and fills from since, the page switches channels with no reload, refetch or socket
#   follows    a login follows names: counts and the flag on a profile, the list with its words, a free name gets a row, the box over the corner
#              panel (hover: who you follow, streaming first; search finds and follows), the watch page's button and count, home's people under
#              the streams (online first) and the top search, a rename keeps the followers
#   dms        direct messages: nobody 401, a stranger 403 until both follows are there, a friend's line kept and listed with its count of what is new,
#              read marks, paging at 50, the window gets a line pushed and sends one back, a hidden window counts on the sidebar and a second tab agrees
#   notifications  the inbox under the bell: nobody 401, the settings save, a follow is a row in the followed inbox (once), a go-live over the api is one
#              live row per follower who keeps it, a friend's newest line is the one unread dm row and reading the thread reads it, the bell counts
#              on two tabs and opening the list reads everything (the other tab drops by push), a pushed row is read at once, the tab's switch, 30 kept
#   preview    /watch/<name> html: title + og tags offline, with a picture, with the offline picture, live with the thumbnail; the pictures round-trip,
#              the offline picture and the line under the word show on the page and in the profile tab
#   errors     /api/health has the monitor fields, a page's error report lands (204, log, debug db), bad ones 400, /admin renders
#   pip        picture in picture: the button goes home with the stream in a corner, the player moves and resizes, has the sound and the chat, pops out into a window
#              of its own and back (SKIP where the browser has no document picture in picture), coming back takes it over, another stream replaces it, × ends it
#   live-pip   picture in picture for the broadcast: leaving /live (a plain home click, or the button) keeps your camera in a corner and the stream up for watchers,
#              you can watch someone else meanwhile (their page's picture in picture is disabled: one corner at a time), the corner has your chat, coming back takes
#              the stream over, × asks first (no keeps streaming) and then stops and frees the corner, a page load stops, leaving with nothing on air puts nothing in the corner, start closes a stream watched in the corner
#   screen     the scene: screens and pictures are layers over the go live page's preview (drag, corner resize, order, hide, presets) and every
#              watcher draws the same frame; a slot left off it is a tile; the mixer's mic and master bars move; a share mid-stream needs no
#              renegotiation; a late watcher sees it all
#   presence   a tab open is online over the events socket, do not disturb and appear offline reach a watcher pushed, live is streaming and
#              the watcher plays on the push (no poll, no player flashing on an offline name), two tabs share one socket and the last
#              closing is offline at once, a claimed name is refused, the inspector shows the frames
#   calendar   the calendar tab: the api's range (93 days at most, the last 20 without one), a go-live is a live block on the watcher's strip,
#              a stop closes it with ended_by stop and the heartbeat's time, a tab that goes offline and away is closed by video within a beat
#              of its last heartbeat, two sessions a minute apart are one block with a mark at the drop, the strip pages, an account's rows
#   about      the about tab: the about me (through the api on a free name, first on the tab, written in place by the owner), then the
#              sample's blocks and media (this origin only), the music player plays and pauses, every css selector lands under the box,
#              hostile css (hide the page, restyle the title, url(), @import, @font-face, position: fixed, a closing tag) is stripped
#              with nothing fetched and nothing outside the box touched
#   socials    the socials tab: a login's document of links through the api (a url that is not http(s), a kind off the list, too many links
#              and a stranger all refused), the links drawn on the watcher's tab as anchors that leave safely (rel, target) wearing the
#              layout and the size, nothing fetched from elsewhere, the owner editing them on that tab (the editor under the strip: the
#              cards, a row from its square, the arrows, ×; the strip follows the draft, done shows the saved document); the corner
#              panel's picture is your page and the gear is in it
#   regress    token-gated stop, auto-recovery, trailing slash, fast restart, races, bad offers
#   monitor    (local only) `api monitor` watches this stack and a dead address: up with the right build,
#              down with a reason, the page shows both, a restart keeps its memory. runs monitor/docker-compose.yml
#   redeploy   (--all, local only) partial ./scripts/deploy.sh runs while a stream is live
#   dummy      (--all, local only, needs DUMMY_STREAMS >= 1) the fake streams play and dummy- names are gated
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

ALL=0
BASE=""
for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;   # the header above, up to the first code line
    --all) ALL=1 ;;
    http://*|https://*) BASE="${a%/}" ;;
    *) die "don't know what '$a' is. see ./scripts/test.sh --help" ;;
  esac
done

have node || die "node is not installed. https://nodejs.org"

# local stack unless a url was given
LOCAL=0
if [ -z "$BASE" ]; then
  LOCAL=1
  ip="$(sed -n 's/^[[:space:]]*PUBLIC_IP=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
  [ -n "$ip" ] || die "no .env yet. run ./scripts/deploy.sh first"
  BASE="https://$ip"
  # the errors suite reads reports back through /api/errors when the local stack has a token.
  # an inline ` # comment` goes, like compose drops it; the api ignores a token under 16 characters
  OPS_TOKEN="${OPS_TOKEN:-$(sed -n 's/^[[:space:]]*OPS_TOKEN=//p' .env 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*$//' | tr -d "\"' \t\r")}"
fi

say "target: $BASE"
# nothing answering at all is a stack that is not up: start it (locally). a 502 (caddy up,
# api not) or a 503 (the api says a part is down) is a stack that is up and sick: say so
# and stop, never deploy over it. a 200 is the way on
code="$(curl -ks -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/health" 2>/dev/null || true)"
case "$code" in
  200) ;;
  000|"")
    if [ "$LOCAL" = 1 ]; then
      # no answer with containers up is a stack that hangs (a wedged database, a box out of
      # memory), not one to deploy over
      [ -z "$(docker compose ps -q frontend api 2>/dev/null)" ] || die "$BASE/api/health does not answer but the stack's containers are up: look before deploying.  docker compose ps; docker compose logs api"
      say "stack is down, starting it"
      ./scripts/deploy.sh --build >/dev/null   # the tests are about this checkout, so its own build, not the registry's images
    else
      die "$BASE/api/health does not answer"
    fi ;;
  *) die "$BASE/api/health answers $code, not 200: the stack is up but sick. locally:  docker compose ps; docker compose logs api redis database" ;;
esac

# the monitor suite starts `api monitor` from the image the running api was started from
# (the registry's name and tag, or stream-api:latest when built here), read off the
# container, after the deploy above: .env's record is not kept up by a --build
MONITOR_IMAGE=""
if [ "$LOCAL" = 1 ]; then
  api_id="$(docker compose ps -q api 2>/dev/null | head -n 1 || true)"
  [ -z "$api_id" ] || MONITOR_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$api_id" 2>/dev/null || true)"
fi

if [ ! -d test/node_modules ]; then
  say "installing playwright (once)"
  (cd test && npm install --no-audit --no-fund >/dev/null)
fi

failed=0
run() {
  say "$1"
  if BASE_URL="$BASE" LOCAL="$LOCAL" OPS_TOKEN="${OPS_TOKEN:-}" MONITOR_IMAGE="${MONITOR_IMAGE:-}" node "test/$1.js"; then :; else failed=$((failed + 1)); fi
}

run e2e
run dup
run chat
run auth
run groups
run follows
run dms
run notifications
run preview
run errors
run pip
run live-pip
run screen
run presence
run calendar
run about
run socials
if [ "$LOCAL" = 1 ]; then
  run regress
  run monitor
  if [ "$ALL" = 1 ]; then
    run redeploy
    dummies="$(sed -n 's/^[[:space:]]*DUMMY_STREAMS=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
    if [ "${dummies:-0}" -ge 1 ] 2>/dev/null; then
      run dummy
    else
      say "dummy: skipped (DUMMY_STREAMS is 0 in .env)"
    fi
  fi
else
  say "regress, monitor and redeploy touch docker here, so they only run against the local stack"
fi

printf '\n'
if [ "$failed" -eq 0 ]; then
  say "ALL GOOD"
else
  say "$failed suite(s) FAILED"
fi
[ "$failed" -eq 0 ]
