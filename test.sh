#!/usr/bin/env bash
#
# test.sh — prove the whole thing works, with real browsers.
#
#   ./test.sh                      the stack on this machine (starts it if it is down)
#   ./test.sh https://1.2.3.4      a server somewhere else, from this laptop
#   ./test.sh --all                also the redeploy test (runs ./deploy.sh api/frontend/video)
#   HEADED=1 ./test.sh             watch the browsers
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
#   preview    /watch/<name> html: title + og tags offline, with a picture, live with the thumbnail; the picture round-trips
#   errors     /api/health has the monitor fields, a page's error report lands (204, log, debug db), bad ones 400, /admin renders
#   regress    token-gated stop, auto-recovery, trailing slash, fast restart, races, bad offers
#   monitor    (local only) `api monitor` watches this stack and a dead address: up with the right build,
#              down with a reason, the page shows both, a restart keeps its memory. runs monitor/docker-compose.yml
#   redeploy   (--all, local only) partial ./deploy.sh runs while a stream is live
#   dummy      (--all, local only, needs DUMMY_STREAMS >= 1) the fake streams play and dummy- names are gated
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
    *) die "don't know what '$a' is. see ./test.sh --help" ;;
  esac
done

have node || die "node is not installed. https://nodejs.org"

# local stack unless a url was given
LOCAL=0
if [ -z "$BASE" ]; then
  LOCAL=1
  ip="$(sed -n 's/^[[:space:]]*PUBLIC_IP=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
  [ -n "$ip" ] || die "no .env yet. run ./deploy.sh first"
  BASE="https://$ip"
  # the errors suite reads reports back through /api/errors when the local stack has a token.
  # an inline ` # comment` goes, like compose drops it; the api ignores a token under 16 characters
  OPS_TOKEN="${OPS_TOKEN:-$(sed -n 's/^[[:space:]]*OPS_TOKEN=//p' .env 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*$//' | tr -d "\"' \t\r")}"
fi

say "target: $BASE"
if ! curl -ks -o /dev/null --max-time 5 "$BASE/api/health"; then
  if [ "$LOCAL" = 1 ]; then
    say "stack is down, starting it"
    ./deploy.sh >/dev/null
  else
    die "$BASE/api/health does not answer"
  fi
fi

if [ ! -d test/node_modules ]; then
  say "installing playwright (once)"
  (cd test && npm install --no-audit --no-fund >/dev/null)
fi

failed=0
run() {
  say "$1"
  if BASE_URL="$BASE" LOCAL="$LOCAL" OPS_TOKEN="${OPS_TOKEN:-}" node "test/$1.js"; then :; else failed=$((failed + 1)); fi
}

run e2e
run dup
run chat
run auth
run preview
run errors
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
