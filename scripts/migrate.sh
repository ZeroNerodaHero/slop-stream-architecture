#!/usr/bin/env bash
# migrate.sh: the data migrations that are not the database's schema. scripts/migrate-scripts/migrate-1.sh,
# then migrate-2.sh, and so on: each runs once on this box and its number is written to .migrated
# (gitignored, beside .deployed), the way api/migrations/migrate-<n>.sql each run once and are written
# to schema_migrations. deploy.sh runs this after the health check on every run that gets that far,
# and on a --pull that finds nothing to redeploy, so a pull that brings a script brings its effect.
#
#   ./scripts/migrate.sh             the scripts not yet recorded, in order. stops at the first that fails
#   ./scripts/migrate.sh --dry-run   each pending script says what it would do, and does nothing
#   ./scripts/migrate.sh --all       every script, recorded or not. each looks before it acts, so this is
#                                    safe: one with nothing to do says so and costs a few reads
#
# a script is for data that is already there when a release changes what it expects of it: redis
# streams, the bucket, rows a schema file cannot fill. it looks before it acts (reads the data, says
# what it found, does nothing when there is nothing to do), so a fresh box runs them all in seconds.
# it exits 0 when done or when there was nothing to do, and non-zero when it could not: nothing is
# recorded then, the deploy says so and is not recorded either, and the next deploy (or this, by
# hand) picks up at that script. a change after a script has run is the next number, not an edit.
# the stack has to be up: the scripts work through `docker compose exec` into redis and the database.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

RECORD=".migrated"
DIR="scripts/migrate-scripts"
DRY=0; ALL=0
for a in "$@"; do
  case "$a" in
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;   # the header above, up to the first code line
    --dry-run) DRY=1 ;;
    --all) ALL=1 ;;
    *) die "don't know what '$a' is. it is --dry-run or --all. see ./scripts/migrate.sh --help" ;;
  esac
done

number_of() { local b; b="$(basename "$1")"; b="${b#migrate-}"; printf '%s' "${b%.sh}"; }
# one awk, no pipe into grep: under pipefail a grep that quits early would make this 141
recorded()  { [ -f "$RECORD" ] && awk -v n="$1" '$1 == n { found = 1 } END { exit !found }' "$RECORD"; }
# the first comment line under the shebang: what the script is, for the log
title_of()  { sed -n '2s/^# *//p' "$1"; }

# the scripts by number, and the numbers must go 1, 2, 3: a gap or a repeat is a mistake to stop on
scripts=()
while IFS= read -r f; do
  if [ -n "$f" ]; then scripts+=("$f"); fi
done < <(
  for f in "$DIR"/migrate-*.sh; do
    if [ -e "$f" ]; then printf '%s %s\n' "$(number_of "$f")" "$f"; fi
  done | sort -n | cut -d' ' -f2-
)
i=0
for f in ${scripts[@]+"${scripts[@]}"}; do
  i=$((i + 1))
  [ "$(number_of "$f")" = "$i" ] || die "$DIR has $(basename "$f") where migrate-$i.sh should be: the files go one, then two, with no gap"
done

pending=()
for f in ${scripts[@]+"${scripts[@]}"}; do
  if [ "$ALL" = 1 ] || ! recorded "$(number_of "$f")"; then pending+=("$f"); fi
done
if [ ${#pending[@]} -eq 0 ]; then
  note "migrations: every script in $DIR has run here ($RECORD). nothing to do"
  exit 0
fi

# docker, as deploy.sh found it (DOCKER_CMD), else as this user reaches it. only now: with
# nothing pending there is nothing to reach
if [ -z "${DOCKER_CMD:-}" ]; then
  if docker info >/dev/null 2>&1; then DOCKER_CMD=docker
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then DOCKER_CMD="sudo docker"
  else die "docker is not answering here. the migrations run on the box, beside the stack"
  fi
fi
export DOCKER_CMD
# shellcheck disable=SC2086
[ -n "$($DOCKER_CMD compose ps -q redis database 2>/dev/null)" ] || die "the stack is not up here (no redis or database container). ./scripts/deploy.sh first"

suffix=""; [ "$DRY" = 0 ] || suffix="   (dry run)"
for f in "${pending[@]}"; do
  n="$(number_of "$f")"
  say "migration $n: $(title_of "$f")$suffix"
  if [ "$DRY" = 1 ]; then
    bash "$f" --dry-run || die "migration $n could not even look (exit $?). see above"
    continue
  fi
  if bash "$f"; then
    # once per script: --all runs a recorded one again and leaves its line as it is
    recorded "$n" || printf '%s %s %s\n' "$n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$f")" >> "$RECORD"
  else
    rc=$?
    die "migration $n failed (exit $rc). nothing after it ran and nothing was recorded. fix it and run ./scripts/migrate.sh, or the next ./scripts/deploy.sh retries it"
  fi
done
[ "$DRY" = 1 ] || note "recorded in $RECORD"
