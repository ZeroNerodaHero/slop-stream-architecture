#!/usr/bin/env bash
# models.sh: the demo models (docs/vtuber.md) from random-media/vrms into the bucket, where the go
# live page's picker lists them (GET /api/models): a name, an author, a licence and a thumbnail each.
#
#   ./scripts/models.sh               put what is new or changed, take out what left the folder
#   ./scripts/models.sh --dry-run     read the folder and print the list it would write. nothing is touched
#   ./scripts/models.sh --if-changed  nothing at all when the folder is as the last run left it (.models,
#                                     gitignored). deploy.sh runs it this way after the health check
#   ./scripts/models.sh DIR           another folder than random-media/vrms
#
# a model is <name>.vrm, and its id is that name (lowercase, a-z 0-9 - _). a picture beside it with the
# same name (<name>.jpg, .png or .webp, 512 kb at most) is its thumbnail; without one the model's own
# embedded thumbnail is used when it is that small, else it has none. the name, the author and the
# licence come out of the file's own meta. drop a .vrm in the folder and run this (or deploy).
#
# the folder goes into the api container and `api models` there reads it and puts it in the bucket
# the api uses: the s3 container, or the one S3_ENDPOINT names. a file that is no vrm is skipped and
# said, and the run exits non-zero; the rest still goes up. runs where the stack runs; needs docker.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

RECORD=".models"
DIR="random-media/vrms"
DRY=0; IF_CHANGED=0
for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;   # the header above, up to the first code line
    --dry-run) DRY=1 ;;
    --if-changed) IF_CHANGED=1 ;;
    -*) die "don't know what '$a' is. it is --dry-run or --if-changed, or a folder. see ./scripts/models.sh --help" ;;
    *) DIR="$a" ;;
  esac
done
[ -d "$DIR" ] || die "no folder at $DIR"

# the models and the pictures beside them, by name. a read loop, not mapfile: a mac's bash is 3.2
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(
  cd "$DIR" && find . -maxdepth 1 -type f \( -iname '*.vrm' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) | sed 's|^\./||' | sort
)

# what the folder holds, as one line: every file's checksum, size and name, summed again
fingerprint() {
  if [ ${#FILES[@]} -eq 0 ]; then printf 'empty'; return 0; fi
  (cd "$DIR" && cksum "${FILES[@]}") | cksum | awk '{ print $1 "-" $2 }'
}
NOW="$(fingerprint)"
if [ "$IF_CHANGED" = 1 ] && [ -f "$RECORD" ] && [ "$(tr -d '[:space:]' < "$RECORD")" = "$NOW" ]; then
  note "demo models: $DIR is as the last run left it ($RECORD). nothing to do"
  exit 0
fi

# docker, as deploy.sh found it (DOCKER_CMD), else as this user reaches it
if [ -z "${DOCKER_CMD:-}" ]; then
  if docker info >/dev/null 2>&1; then DOCKER_CMD=docker
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then DOCKER_CMD="sudo docker"
  else die "docker is not answering here. models.sh runs on the box, beside the stack"
  fi
fi
# shellcheck disable=SC2086
dc() { $DOCKER_CMD compose "$@"; }
[ -n "$(dc ps -q api 2>/dev/null)" ] || die "the api container is not up. ./scripts/deploy.sh first"

# an api from before the demo models has no `models` word: it would start a second server instead.
# its own route says which this is (200 with a list, or 404 `no such route`), asked from inside
# the container the way its health check asks
if ! dc exec -T api bash -c "exec 3<>/dev/tcp/127.0.0.1/4000 && printf 'GET /api/models HTTP/1.0\r\n\r\n' >&3 && head -n1 <&3 | grep -q ' 200 '" >/dev/null 2>&1; then
  die "the api here does not have the demo models yet (GET /api/models is not a 200). ./scripts/deploy.sh api first, then this"
fi

say "demo models: $DIR -> the bucket$([ "$DRY" = 0 ] || printf '   (dry run)')"
IN="/tmp/models-in"
cleanup() { dc exec -T api rm -rf "$IN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
dc exec -T api sh -c "rm -rf $IN && mkdir -p $IN" || die "could not make $IN in the api container"
if [ ${#FILES[@]} -gt 0 ]; then
  # COPYFILE_DISABLE: a mac's tar would send its ._ twins along
  (cd "$DIR" && COPYFILE_DISABLE=1 tar -cf - "${FILES[@]}") | dc exec -T api tar -C "$IN" -xf - || die "could not copy $DIR into the api container"
fi

ARGS=("$IN"); [ "$DRY" = 0 ] || ARGS+=(--dry-run)
# RUST_LOG=warn: without it the bucket's "is there" lines come first
if dc exec -T -e RUST_LOG=warn api api models "${ARGS[@]}"; then
  if [ "$DRY" = 0 ]; then printf '%s\n' "$NOW" > "$RECORD"; note "recorded in $RECORD"; fi
else
  rc=$?
  # what could go up went up, but the folder is not all in the bucket: not recorded, so the next run tries again
  die "the demo models did not all go up (exit $rc, above). fix the folder and run ./scripts/models.sh again"
fi
