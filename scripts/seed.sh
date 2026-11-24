#!/usr/bin/env bash
# seed.sh: a few accounts that look like people, so there is somebody to find, to watch and,
# once docs/follows.md is built, to follow. for a box you are styling or testing on.
#
#   ./scripts/seed.sh                     five of them
#   ./scripts/seed.sh 12                  twelve
#   ./scripts/seed.sh 3 --pictures DIR    cut the pictures from DIR instead of random-media/random-pfps
#   ./scripts/seed.sh --dummies           no accounts: a bio, a face and a thumbnail for every fake stream (dummy-*) instead,
#                                 with the dummy box's password (DUMMY_PASSWORD in .env), so they look like
#                                 people on home and in search. the dummy must have run once (it makes the rows)
#
# each one gets a two-word name (quiet-otter, neon-heron), an account with a random password,
# a bio put together from random pieces, a profile picture and one home-card thumbnail. the two pictures are two random files
# from random-media/random-pfps (jpg, png, gif or webp, any size): ffmpeg, in docker, cuts the
# 256x256 and 640x360 jpegs the pages would have made. names and passwords are appended to
# .seeded-users (gitignored), one per line, so you can log in as any of them.
#
# the account comes from `api passwd <name>`, the path ./scripts/deploy.sh passwd uses: no signup
# limit to run into, and a name that already has an account (or is held after a rename,
# docs/ids.md) is skipped for another. the rest goes through the api at https://<PUBLIC_IP>
# (.env), through caddy, the way test.sh does. runs where the stack runs; needs docker and curl.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

COUNT=5; PICS="random-media/random-pfps"; DUMMIES=0
want_pics=0
for a in "$@"; do
  if [ "$want_pics" = 1 ]; then PICS="$a"; want_pics=0; continue; fi
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    --pictures) want_pics=1 ;;
    --pictures=*) PICS="${a#--pictures=}" ;;
    --dummies) DUMMIES=1 ;;
    *) if [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -ge 1 ] && [ "$a" -le 200 ]; then COUNT="$a"; else die "don't know what '$a' is. a count (1 to 200), or --pictures DIR. see ./scripts/seed.sh --help"; fi ;;
  esac
done
[ "$want_pics" = 0 ] || die "--pictures needs a folder"

have docker || die "docker is not installed here. seed.sh runs where the stack runs"
have curl || die "curl is needed"
docker info >/dev/null 2>&1 || die "docker is not answering. is it running?"
[ -n "$(docker compose ps -q api 2>/dev/null)" ] || die "the api container is not up. ./scripts/deploy.sh first"
[ -d "$PICS" ] || die "no pictures folder at $PICS"
PICS="$(cd "$PICS" && pwd)"
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(find "$PICS" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.gif' -o -iname '*.webp' \) | sort)
[ ${#FILES[@]} -ge 1 ] || die "no jpg, png, gif or webp in $PICS"

ip="$(sed -n 's/^[[:space:]]*PUBLIC_IP=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \t\r")"
[ -n "$ip" ] || die "no PUBLIC_IP in .env yet. run ./scripts/deploy.sh first"
BASE="https://$ip"
curl -sk -o /dev/null --max-time 5 "$BASE/api/health" || die "nothing answers at $BASE. is the stack up?"

FFMPEG_IMAGE="mwader/static-ffmpeg:7.1"

ADJ=(quiet neon rusty velvet sleepy brave cosmic dusty gentle hollow lunar misty nimble polar rapid solar tidal witty amber crisp)
NOUN=(otter heron fox lynx moth owl pike raven seal tern wren yak bison crane dingo egret finch gecko ibis koala)
OPENERS=(
  "streams whenever the coffee kicks in."
  "night owl."
  "learning in public."
  "cozy streams from a very small apartment."
  "weekend streamer, weekday human."
  "mostly here for the chat, honestly."
  "art, sometimes."
  "speedrunning my own todo list."
  "no schedule, no plan."
  "trying every hobby once so you don't have to."
  "late starts, long streams."
  "building a thing. it is almost done. it has been almost done for a year."
  "retro games and bad takes."
  "a desk, a lamp, a microphone."
)
MIDDLES=(
  "mostly building things, sometimes breaking them."
  "bad jokes, decent music."
  "ask me anything, i probably don't know either."
  "the cat shows up around hour two."
  "it is not going well."
  "talking, always."
  "lo-fi and long silences."
  "expect tangents."
  "i read every line of chat, eventually."
  "half of this is me looking for a file."
  "the plant in the corner is doing better than the project."
  "we take breaks seriously here."
)
CLOSERS=(
  "be nice."
  "say hi."
  "no face cam, ever."
  "the mic is fine, i promise."
  "come hang out."
  "" "" "" ""
)
random_bio() {
  local a="${OPENERS[$(rand ${#OPENERS[@]})]}" b="${MIDDLES[$(rand ${#MIDDLES[@]})]}" c="${CLOSERS[$(rand ${#CLOSERS[@]})]}"
  if [ -n "$c" ]; then printf '%s %s %s' "$a" "$b" "$c"; else printf '%s %s' "$a" "$b"; fi
}
json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

JAR="$(mktemp)"; TMP="$(mktemp -d)"
trap 'rm -rf "$JAR" "$TMP"' EXIT

rand() { echo $(( RANDOM % $1 )); }

cut_picture() {
  local src="$1" size="$2" out="$3" q=4
  while :; do
    docker run --rm -v "$PICS:/in:ro" -v "$TMP:/out" "$FFMPEG_IMAGE" -hide_banner -loglevel error -y \
      -i "/in/$(basename "$src")" -frames:v 1 \
      -vf "scale=${size}:force_original_aspect_ratio=increase,crop=${size},format=yuvj420p" \
      -q:v "$q" "/out/$(basename "$out")" || return 1
    [ "$(wc -c < "$out")" -le 250000 ] && return 0
    q=$((q + 4)); [ "$q" -le 20 ] || return 1
  done
}

status() { curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

urlencode() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9.~_-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}

clear_login_limit() {
  docker compose exec -T redis sh -c "for p in 'rl:login:*' 'rl:route:*'; do redis-cli --scan --pattern \"\$p\" | xargs -r redis-cli del; done" >/dev/null 2>&1 || true
}

docker image inspect "$FFMPEG_IMAGE" >/dev/null 2>&1 || { note "getting $FFMPEG_IMAGE once"; docker pull -q "$FFMPEG_IMAGE" >/dev/null || die "could not pull $FFMPEG_IMAGE"; }

if [ "$DUMMIES" = 1 ]; then
  dpw="$(sed -n 's/^[[:space:]]*DUMMY_PASSWORD=//p' .env 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*$//' | tr -d "\"' \t\r")"
  [ -n "$dpw" ] || die "no DUMMY_PASSWORD in .env: the fake streams' names are written with it"
  names="$(curl -sk --max-time 10 "$BASE/api/search?q=dummy-" | grep -o '"name":"dummy-[^"]*"' | cut -d'"' -f4)"
  [ -n "$names" ] || die "no dummy-* rows yet. set DUMMY_STREAMS in .env and ./scripts/deploy.sh dummy first"
  say "faces for the fake streams at $BASE, pictures from $PICS"
  pq="$(urlencode "$dpw")"
  for name in $names; do
    a="${FILES[$(rand ${#FILES[@]})]}"; b="${FILES[$(rand ${#FILES[@]})]}"
    [ ${#FILES[@]} -gt 1 ] && while [ "$b" = "$a" ]; do b="${FILES[$(rand ${#FILES[@]})]}"; done
    code="$(status -X PUT "$BASE/api/streamers/$name?password=$pq" -H 'content-type: application/json' -d "{\"bio\":$(json_string "$(random_bio)")}")"
    [ "$code" = 200 ] || warn "$name: bio got $code"
    if cut_picture "$a" 256:256 "$TMP/avatar.jpg"; then
      code="$(status -X PUT "$BASE/api/streamers/$name/avatar?password=$pq" -H 'content-type: image/jpeg' --data-binary "@$TMP/avatar.jpg")"
      [ "$code" = 200 ] || warn "$name: picture got $code"
    fi
    if cut_picture "$b" 640:360 "$TMP/thumb.jpg"; then
      code="$(status -X PUT "$BASE/api/streamers/$name/thumbs?password=$pq" -H 'content-type: image/jpeg' --data-binary "@$TMP/thumb.jpg")"
      [ "$code" = 200 ] || [ "$code" = 409 ] || warn "$name: thumbnail got $code"
    fi
    note "$name  ($(basename "$a") / $(basename "$b"))"
  done
  say "done. the fake streams have faces"
  exit 0
fi

say "seeding $COUNT account(s) at $BASE, pictures from $PICS (${#FILES[@]} file(s))"

made=0; tries=0
while [ "$made" -lt "$COUNT" ]; do
  tries=$((tries + 1)); [ "$tries" -le $((COUNT * 6)) ] || die "ran out of free names after $tries tries. made $made"
  name="${ADJ[$(rand ${#ADJ[@]})]}-${NOUN[$(rand ${#NOUN[@]})]}"
  [ "$tries" -gt 40 ] && name="$name$(rand 100)"
  if curl -sk --max-time 10 "$BASE/api/streamers/$name" | grep -q '"verified":true'; then continue; fi

  out="$(docker compose exec -T -e RUST_LOG=warn api api passwd "$name" 2>&1)" || { note "skip $name: ${out##*$'\n'}"; continue; }
  pw="$(printf '%s\n' "$out" | sed -n 's/.*new password is[[:space:]]*//p' | head -n 1 | tr -d '[:space:]')"
  [ -n "$pw" ] || { warn "no password in: $out"; continue; }

  : > "$JAR"
  code="$(status -c "$JAR" -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"name\":\"$name\",\"password\":\"$pw\"}")"
  if [ "$code" = 429 ]; then clear_login_limit; code="$(status -c "$JAR" -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"name\":\"$name\",\"password\":\"$pw\"}")"; fi
  [ "$code" = 200 ] || { warn "$name: login got $code"; continue; }

  bio="$(random_bio)"
  code="$(status -b "$JAR" -X PUT "$BASE/api/streamers/$name" -H 'content-type: application/json' -d "{\"bio\":$(json_string "$bio")}")"
  [ "$code" = 200 ] || warn "$name: bio got $code"

  a="${FILES[$(rand ${#FILES[@]})]}"; b="${FILES[$(rand ${#FILES[@]})]}"
  [ ${#FILES[@]} -gt 1 ] && while [ "$b" = "$a" ]; do b="${FILES[$(rand ${#FILES[@]})]}"; done
  if cut_picture "$a" 256:256 "$TMP/avatar.jpg"; then
    code="$(status -b "$JAR" -X PUT "$BASE/api/streamers/$name/avatar" -H 'content-type: image/jpeg' --data-binary "@$TMP/avatar.jpg")"
    [ "$code" = 200 ] || warn "$name: picture got $code"
  else
    warn "$name: could not cut a picture from $(basename "$a")"
  fi
  if cut_picture "$b" 640:360 "$TMP/thumb.jpg"; then
    code="$(status -b "$JAR" -X PUT "$BASE/api/streamers/$name/thumbs" -H 'content-type: image/jpeg' --data-binary "@$TMP/thumb.jpg")"
    [ "$code" = 200 ] || warn "$name: thumbnail got $code"
  else
    warn "$name: could not cut a thumbnail from $(basename "$b")"
  fi

  printf '%s %s\n' "$name" "$pw" >> .seeded-users
  made=$((made + 1))
  note "$name  ($(basename "$a") / $(basename "$b"))   $BASE/watch/$name"
done

say "done: $made account(s). names and passwords are in .seeded-users"
note "log in as one at $BASE/login, or look at them: ./scripts/manage.sh --db  (the streamers table)"
