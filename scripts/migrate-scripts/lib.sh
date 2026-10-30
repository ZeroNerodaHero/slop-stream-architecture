# lib.sh: what every script in this folder starts with.
#
#   . "$(dirname "$0")/lib.sh" "$@"
#
# The repo root as the working directory, the arguments read (--dry-run sets DRY=1; --help prints
# the script's own header), and three ways into the running stack, all through `docker compose
# exec` (neither redis nor the database has a host port, so this works wherever the stack runs):
#
#   compose ...     docker compose, as migrate.sh reached docker (DOCKER_CMD: "docker" or
#                   "sudo docker"); plain docker when run by hand
#   redis ...       redis-cli in the stack's redis. an array reply is one element per line
#   sql "<query>"   psql in the stack's database, one row per line, the fields separated by a
#                   space (names and ids never have one), no header. a failing statement fails
#   note / die      a line of progress; a failure that ends the script non-zero
#
# A script looks before it acts: reads the data, says what it found, and exits 0 having done
# nothing when there is nothing to do. With --dry-run it stops after saying. It exits non-zero
# only when it could not do what it found to do; migrate.sh then records nothing and stops.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

note() { printf '    %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;   # the header above the first code line
    *) die "don't know what '$a' is. a migration script takes --dry-run, or nothing" ;;
  esac
done

read -r -a DOCKER <<< "${DOCKER_CMD:-docker}"
compose() { "${DOCKER[@]}" compose "$@"; }
# -T: no tty, so the output is plain lines that pipe. the \r a tty-less redis-cli still prints goes
redis()   { compose exec -T redis redis-cli "$@" | tr -d '\r'; }
sql()     { compose exec -T database psql -U stream -v ON_ERROR_STOP=1 -qAtF ' ' -c "$1" | tr -d '\r'; }
