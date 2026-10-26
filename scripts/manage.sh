#!/usr/bin/env bash
# manage.sh: look inside the running stack's postgres and redis, from a terminal. read-only.
#
#   ./scripts/manage.sh --db              the tables of the stream database: pick one, see its rows
#                                 (scroll, page, a where clause), its columns and indexes,
#                                 or type a query. `d` hops to the other database (debug)
#   ./scripts/manage.sh --db debug        start on the error-report database instead
#   ./scripts/manage.sh --redis           every key with its type and ttl: pick one, see what is in
#                                 it (a string, a hash, a sorted set with scores, a stream's
#                                 last 500 entries). `/` narrows the scan pattern
#
# everything goes through `docker compose exec` into the database and redis containers
# (neither has a host port), so it works wherever the stack runs: here, or on the box over
# ssh, like ship.sh's --to. docker must answer for your ssh user there (./scripts/deploy.sh puts
# you in the docker group).
#
#   ./scripts/manage.sh --to billy@1.2.3.4 --redis         the repo is ~/slop-stream-architecture there
#   ./scripts/manage.sh --to gcloud:test-machine --db      or --dir <path> to say where it is
#
# the screen is python3's curses, run here, not on the box. keys: ↑↓ move, pgup pgdn page,
# ←→ scroll the columns, enter opens, / filters, r asks again, q goes back, ? says this.
# nothing here writes: every query runs in a read-only transaction that is rolled back.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

MODE=""; DB=stream; TO=""; DIR=slop-stream-architecture
want_to=0; want_dir=0; want_db=0
for a in "$@"; do
  if [ "$want_to" = 1 ]; then TO="$a"; want_to=0; continue; fi
  if [ "$want_dir" = 1 ]; then DIR="$a"; want_dir=0; continue; fi
  # the word after --db is the database, unless it is clearly a flag
  if [ "$want_db" = 1 ]; then
    want_db=0
    case "$a" in -*) ;; *) DB="$a"; continue ;; esac
  fi
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;   # the header above, up to the first code line
    --db) MODE=db; want_db=1 ;;
    --db=*) MODE=db; DB="${a#--db=}" ;;
    --redis) MODE=redis ;;
    --to) want_to=1 ;;
    --to=*) TO="${a#--to=}" ;;
    --dir) want_dir=1 ;;
    --dir=*) DIR="${a#--dir=}" ;;
    *) die "don't know what '$a' is. it is --db [name], --redis, --to <host>, --dir <path>. see ./scripts/manage.sh --help" ;;
  esac
done
[ "$want_to" = 0 ] || die "--to needs a destination: gcloud:<instance>, or user@host"
[ "$want_dir" = 0 ] || die "--dir needs a path"
[ -n "$MODE" ] || die "say what to look at: --db [name] or --redis. see ./scripts/manage.sh --help"
[[ "$DB" =~ ^[a-z0-9_]+$ ]] || die "bad database name '$DB'. the two here are stream and debug"

[ -t 0 ] && [ -t 1 ] || die "manage.sh draws a screen: run it in a terminal, not through a pipe"
have python3 || die "python3 is needed here: it draws the screen. brew install python, or apt install python3"
python3 -c 'import curses' 2>/dev/null || die "this python3 has no curses module (the one from python.org and homebrew's do)"

if [ -z "$TO" ]; then
  have docker || die "docker is not installed here. point at the box instead: --to user@host"
  docker info >/dev/null 2>&1 || die "docker is not answering here. start it, or point at the box: --to user@host"
  [ "$MODE" = db ] && svc=database || svc=redis
  [ -n "$(docker compose ps -q "$svc" 2>/dev/null)" ] || die "the stack is not up here (no $svc container). ./scripts/deploy.sh first, or --to user@host"
fi

MANAGE_MODE="$MODE" MANAGE_DB="$DB" MANAGE_TO="$TO" MANAGE_DIR="$DIR" exec python3 manage.py
