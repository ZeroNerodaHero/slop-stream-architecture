#!/usr/bin/env bash
# dummy-groups.sh: a few groups, so the list on home has somewhere to click.
#
#   ./scripts/dummy-groups.sh        five
#   ./scripts/dummy-groups.sh 12     twelve
#
# a group is made by a login (POST /api/groups). one account can be in 8, so a
# bigger count uses another account. the account is `api passwd`, the same path
# as seed.sh, so there is no signup limit. the maker's name and password, and
# the group, are appended to .seeded-groups (gitignored).
#
# runs where the stack runs. needs docker and curl. https://<PUBLIC_IP> from .env.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*" >&2; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

COUNT=5
for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) if [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -ge 1 ] && [ "$a" -le 80 ]; then COUNT="$a"; else die "don't know what '$a' is. a count from 1 to 80. see ./scripts/dummy-groups.sh --help"; fi ;;
  esac
done

have docker || die "docker is not installed here. dummy-groups.sh runs where the stack runs"
have curl || die "curl is needed"
docker info >/dev/null 2>&1 || die "docker is not answering. is it running?"
[ -n "$(docker compose ps -q api 2>/dev/null)" ] || die "the api container is not up. ./scripts/deploy.sh first"

ip="$(sed -n 's/^[[:space:]]*PUBLIC_IP=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
[ -n "$ip" ] || die "no PUBLIC_IP in .env yet. run ./scripts/deploy.sh first"
BASE="https://$ip"
curl -sk -o /dev/null --max-time 5 "$BASE/api/health" || die "nothing answers at $BASE. is the stack up?"

# one account is in 8 groups at most, and making one puts the maker in it.
PER=8
ADJ=(night late quiet open neon cozy loud slow west east lunar misty polar solar amber crisp dusty velvet)
NOUN=(owls lobby porch attic den hall yard dock loft crew table room nook bench stoop alley creek)
BADGE=(owl late chat crew pals room den loft yard dock hall nook)
COLOR=("#5865f2" "#f85149" "#3fb950" "#f2cc60" "#bc8cff" "#ff9f43" "#39d2c0" "#ff6bcb")
ABOUT=(
  "come hang out."
  "whoever is around."
  "a room with the camera off."
  "talking, mostly."
  "open. walk in."
)

rand() { echo $(( RANDOM % $1 )); }
status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
clear_login_limit() {
  docker compose exec -T redis sh -c "redis-cli --scan --pattern 'rl:login:*' | xargs -r redis-cli del" >/dev/null 2>&1 || true
}

JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT

# a fresh maker. prints the name. the password is recorded with the groups.
new_maker() {
  local name pw out code tries=0
  while :; do
    tries=$((tries + 1)); [ "$tries" -le 40 ] || die "could not find a free name for a maker"
    name="grp-${ADJ[$(rand ${#ADJ[@]})]}-${NOUN[$(rand ${#NOUN[@]})]}"
    [ "$tries" -gt 15 ] && name="${name}$(rand 100)"
    if curl -sk --max-time 10 "$BASE/api/streamers/$name" | grep -q '"verified":true'; then continue; fi
    out="$(docker compose exec -T -e RUST_LOG=warn api api passwd "$name" 2>&1)" || { note "skip $name"; continue; }
    pw="$(printf '%s\n' "$out" | sed -n 's/.*new password is[[:space:]]*//p' | head -n 1 | tr -d '[:space:]')"
    [ -n "$pw" ] || { warn "no password in: $out"; continue; }
    : > "$JAR"
    code="$(status -c "$JAR" -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"name\":\"$name\",\"password\":\"$pw\"}")"
    if [ "$code" = 429 ]; then clear_login_limit; code="$(status -c "$JAR" -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"name\":\"$name\",\"password\":\"$pw\"}")"; fi
    [ "$code" = 200 ] || { warn "$name: login got $code"; continue; }
    printf '%s %s\n' "$name" "$pw"
    return 0
  done
}

say "making $COUNT group(s) at $BASE"
made=0
tries=0
in_this=0
maker=""; pw=""
while [ "$made" -lt "$COUNT" ]; do
  tries=$((tries + 1))
  [ "$tries" -le $((COUNT * 8)) ] || die "stopping after $tries tries. made $made"
  if [ -z "$maker" ] || [ "$in_this" -ge "$PER" ]; then
    line="$(new_maker)"
    maker="${line%% *}"
    pw="${line#* }"
    in_this=0
    note "maker $maker"
  fi
  gname="${ADJ[$(rand ${#ADJ[@]})]}-${NOUN[$(rand ${#NOUN[@]})]}"
  [ "$tries" -gt 20 ] && gname="${gname}$(rand 100)"
  badge="${BADGE[$(rand ${#BADGE[@]})]}"
  color="${COLOR[$(rand ${#COLOR[@]})]}"
  about="${ABOUT[$(rand ${#ABOUT[@]})]}"
  code="$(curl -sk -o "$BODY" -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/groups" \
    -H 'content-type: application/json' \
    -d "{\"name\":\"$gname\",\"badge\":\"$badge\",\"color\":\"$color\",\"about\":\"$about\"}")"
  if [ "$code" = 409 ]; then continue; fi
  if [ "$code" = 403 ]; then
    note "$maker is full. another account."
    maker=""; in_this=0
    continue
  fi
  if [ "$code" != 201 ]; then
    warn "$gname got $code $(head -c 200 "$BODY" 2>/dev/null || true)"
    continue
  fi
  # the address is the words plus four digits. an older api answers with the words.
  slug="$(grep -o '"name":"[^"]*"' "$BODY" | head -n 1 | sed 's/"name":"//; s/"$//')"
  [ -n "$slug" ] || slug="$gname"
  printf '%s %s %s %s\n' "$slug" "$badge" "$maker" "$pw" >> .seeded-groups
  made=$((made + 1))
  in_this=$((in_this + 1))
  note "$slug  ($badge)  by $maker"
done

say "done: $made group(s). listed in .seeded-groups"
note "they show on home, under recently offline, and at $BASE/groups"
