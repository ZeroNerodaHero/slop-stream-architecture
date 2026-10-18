#!/usr/bin/env bash
#
# test.sh — prove the whole thing works, with real browsers.
#
#   ./test.sh                      the stack on this machine (starts it if it is down)
#   ./test.sh https://1.2.3.4      a server somewhere else, from this laptop
#   ./test.sh --all                also the redeploy test (runs ./deploy.sh api/frontend/video)
#   HEADED=1 ./test.sh             watch the browsers
#
# Needs node and Google Chrome on the machine running the tests (not the server).
# A fake camera is used, so nothing is recorded and no permission prompt appears.
#
# What runs:
#   e2e        go live -> listed on home -> watcher sees frames -> stop -> watcher sees ended
#   dup        a second person on the same name is refused
#   chat       two viewers talk, history survives a reload, 501 chars refused, streamer lines marked
#   regress    token-gated stop, auto-recovery, trailing slash, fast restart, races, bad offers
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
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  if BASE_URL="$BASE" node "test/$1.js"; then :; else failed=$((failed + 1)); fi
}

run e2e
run dup
run chat
if [ "$LOCAL" = 1 ]; then
  run regress
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
  say "regress and redeploy restart containers, so they only run against the local stack"
fi

printf '\n'
if [ "$failed" -eq 0 ]; then
  say "ALL GOOD"
else
  say "$failed suite(s) FAILED"
fi
[ "$failed" -eq 0 ]
