#!/usr/bin/env bash
#
# ship.sh — build the images on this machine and get them to the box, so the box builds nothing.
#
#   ./scripts/ship.sh --to gcloud:test-machine     build for linux/amd64, send straight to that vm over ssh (docker save | docker load).
#                                          no registry, no account, nothing public. the way to go for one box
#   ./scripts/ship.sh --to billy@1.2.3.4           same, over plain ssh (anything `ssh` accepts: user@host, an ssh config alias)
#   ./scripts/ship.sh --to gcloud:test-machine api video     only these images
#   ./scripts/ship.sh                              build and push to a registry instead (ghcr.io/<owner of the git remote>/ by default,
#                                          IMAGES=ghcr.io/you/ to change). for several boxes, or ci later. needs a docker login
#   ./scripts/ship.sh --local                      build for this machine and keep them here, no send, no push (TAG=local)
#   PLATFORM=linux/arm64 ./scripts/ship.sh ...     another target architecture (default linux/amd64: what the cloud boxes are)
#
# The box is amd64 and this laptop may not be: docker builds for the box's architecture through
# emulation (rust under rosetta is several times slower than native, still minutes where a small
# box takes an hour), with the same Dockerfiles ./scripts/deploy.sh uses. The dependency layers are cached
# here, so a source change rebuilds only that crate.
#
# The tag is the commit the images are named after everywhere: the last one that touched
# what they are built from (./image-paths; -dirty with uncommitted edits there), the rule
# deploy.sh and the github action use too, so a box at the same tree finds them by itself.
#
# After --to, on the box:   ./scripts/deploy.sh --images <the tag this prints>     (the images are there; nothing is pulled)
# After a push, on the box:  ./scripts/deploy.sh --pull                              (the registry comes from the git remote)
#                            login here, once:  gh auth refresh -s write:packages,read:packages
#                                               gh auth token | docker login ghcr.io -u <you> --password-stdin
#                            a package a laptop push creates is private until made public once on github
#                            (the action's are public by themselves)
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

ALL=(pages api video dummy)
TARGETS=()
MODE=push          # push | send | local
TO=""
want_to=0
for a in "$@"; do
  if [ "$want_to" = 1 ]; then TO="$a"; want_to=0; continue; fi
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    --to) MODE=send; want_to=1 ;;
    --to=*) MODE=send; TO="${a#--to=}" ;;
    --local) MODE=local ;;
    pages|frontend) TARGETS+=(pages) ;;
    api|chat|events) TARGETS+=(api) ;;
    video|dummy) TARGETS+=("$a") ;;
    *) die "don't know what '$a' is. images are: pages api video dummy. see ./scripts/ship.sh --help" ;;
  esac
done
[ "$want_to" = 0 ] && { [ "$MODE" != send ] || [ -n "$TO" ]; } || die "--to needs a destination: gcloud:<instance>, or user@host"
[ ${#TARGETS[@]} -gt 0 ] || TARGETS=("${ALL[@]}")

have docker || die "docker is not installed"
docker buildx version >/dev/null 2>&1 || die "docker buildx is missing (docker desktop has it; on linux: apt install docker-buildx-plugin)"
have git || die "git is not installed"

# the same BUILD rule as deploy.sh and the action: the last commit that touched what the
# images are built from (./image-paths, 7 characters), -dirty when that has uncommitted edits
PATHSPECS=()
while IFS= read -r p; do PATHSPECS+=("$p"); done < <(tr -d '\r' < image-paths 2>/dev/null | sed -E 's/[[:space:]]+$//' | grep -Ev '^[[:space:]]*(#|$)' || true)
[ ${#PATHSPECS[@]} -gt 0 ] || die "image-paths is missing or empty in the repo root"
BUILD="$(git log -1 --format=%h --abbrev=7 -- "${PATHSPECS[@]}" 2>/dev/null || true)"
BUILD="${BUILD:-dev}"
if [ "$BUILD" != dev ] && [ -n "$(git status --porcelain -- "${PATHSPECS[@]}" 2>/dev/null)" ]; then
  BUILD="$BUILD-dirty"
fi

# how a command reaches the box. `local` runs it here (for trying this script out).
remote() {
  case "$TO" in
    gcloud:*) gcloud compute ssh "${TO#gcloud:}" --quiet --command "$1" ;;
    local)    sh -c "$1" ;;
    *)        ssh "$TO" "$1" ;;
  esac
}

# the registry name the images go by, the same one deploy.sh derives: ghcr.io/<owner>/ from
# the git remote, lowercased (ghcr wants that). sent images carry it too, so the box finds
# them under the name compose looks for, with nothing to configure.
if [ -z "${IMAGES:-}" ] && [ "$MODE" != local ]; then
  owner="$(git remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)([^/]+)/.*$#\2#' | tr '[:upper:]' '[:lower:]')"
  [ -n "$owner" ] && [ "$owner" != "$(git remote get-url origin 2>/dev/null | tr '[:upper:]' '[:lower:]')" ] || die "cannot tell the registry from the git remote. set it:  IMAGES=ghcr.io/<you>/ ./scripts/ship.sh"
  IMAGES="ghcr.io/$owner/"
fi
IMAGES="${IMAGES:-}"
[ -z "$IMAGES" ] || IMAGES="${IMAGES%/}/"

case "$MODE" in
  push)
    PLATFORM="${PLATFORM:-linux/amd64}"
    TAG="$BUILD"
    OUT=(--push)
    # logged in to that registry? docker keeps a key per host in config.json, even with a credential
    # store. a registry on this machine (localhost:5055, for trying this out) needs no login.
    host="${IMAGES%%/*}"
    if [[ ! "$host" =~ ^(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]] \
       && ! python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if sys.argv[2] in c.get("auths",{}) else 1)' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" "$host" 2>/dev/null; then
      die "not logged in to $host. once:
  gh auth refresh -h github.com -s write:packages,read:packages      (the token needs the package scopes)
  gh auth token | docker login $host -u <your github user> --password-stdin
or skip registries altogether:  ./scripts/ship.sh --to gcloud:<instance>"
    fi ;;
  send)
    PLATFORM="${PLATFORM:-linux/amd64}"
    TAG="$BUILD"
    OUT=(--load)
    say "checking the box ($TO)"
    remote 'command -v docker >/dev/null && docker info >/dev/null 2>&1 && echo "docker answers" || { echo "docker is not usable there for this user (./scripts/deploy.sh installs it; a re-login after that puts you in the docker group)"; exit 1; }' \
      || die "cannot use docker on $TO. run ./scripts/deploy.sh there once (it installs docker), then ship"
    ;;
  local)
    arch="$(uname -m)"; case "$arch" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=amd64 ;; esac
    PLATFORM="${PLATFORM:-linux/$arch}"
    TAG=local
    OUT=(--load) ;;
esac

# the laptop's cores for cargo; the Dockerfiles default to 1 for small boxes
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 2)"

case "$MODE" in
  push)  say "building ${TARGETS[*]} for $PLATFORM as ${IMAGES}stream-<x>:$TAG and :latest, pushing" ;;
  send)  say "building ${TARGETS[*]} for $PLATFORM as ${IMAGES}stream-<x>:$TAG, then sending them to $TO" ;;
  local) say "building ${TARGETS[*]} for $PLATFORM as stream-<x>:$TAG (kept here)" ;;
esac
note "BUILD=$BUILD, CARGO_BUILD_JOBS=$JOBS. the first rust build under emulation takes a while; the next one reuses the dependency layers"

build() {   # image, context, dockerfile
  local name="$1" ctx="$2" file="$3" t0 secs
  local -a tags=(-t "${IMAGES}stream-$name:$TAG")
  [ "$MODE" != push ] || tags+=(-t "${IMAGES}stream-$name:latest")
  t0=$(date +%s)
  say "stream-$name"
  docker buildx build --platform "$PLATFORM" --build-arg BUILD="$BUILD" --build-arg CARGO_BUILD_JOBS="$JOBS" \
    "${tags[@]}" "${OUT[@]}" -f "$file" "$ctx" \
    || die "building stream-$name failed. 'signal: 9, SIGKILL' in the output means docker's vm ran out of memory: give it more in docker desktop › resources, or CARGO_BUILD_JOBS=2 ./scripts/ship.sh"
  secs=$(( $(date +%s) - t0 ))
  note "stream-$name done in $(( secs / 60 ))m $(( secs % 60 ))s"
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    pages) build pages frontend frontend/Dockerfile ;;
    api)   build api . api/Dockerfile ;;
    video) build video . video/Dockerfile ;;
    dummy) build dummy . video/Dockerfile.dummy ;;
  esac
done

if [ "$MODE" = send ]; then
  # one stream: the images as a tar, gzipped, straight into docker on the box. layers the
  # images share (debian, ffmpeg) go once. nothing lands on disk at either end.
  names=(); for t in "${TARGETS[@]}"; do names+=("${IMAGES}stream-$t:$TAG"); done
  say "sending ${names[*]} to $TO"
  t0=$(date +%s)
  docker save --platform "$PLATFORM" "${names[@]}" | gzip -1 \
    | remote 'docker load' \
    || die "sending failed. is ssh to $TO working, and docker usable there?"
  note "sent in $(( ($(date +%s) - t0) / 60 ))m $(( ($(date +%s) - t0) % 60 ))s"
fi

say "done: ${TARGETS[*]} as $TAG"
case "$MODE" in
  local) note "run them here with:  TAG=local docker compose up -d --no-build" ;;
  send)
    note "on the box:  cd slop-stream-architecture && ./scripts/deploy.sh --images $TAG"
    note "(it finds them here under that tag and pulls nothing. --pull first if the compose file or caddyfile changed too)" ;;
  push)
    if [[ "$TAG" == *-dirty ]]; then
      note "on the box:  ./scripts/deploy.sh --images $TAG     (uncommitted edits went into these, so the box cannot work the tag out; commit, and --pull finds them by itself)"
    else
      note "on the box:  ./scripts/deploy.sh --pull     (once it has this commit it names the images the same way, so no tag to type; the registry comes from the git remote)"
    fi
    note "a 'denied' on the pull means a package a laptop push created is private (the action's are public by themselves): github › your profile › Packages › stream-x › Package settings › Change visibility › public" ;;
esac
