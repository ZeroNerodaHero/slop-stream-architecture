#!/bin/sh
# What the tech-docs skill reads before it writes: where the docs stand, the last 100 commits, and
# what moved since the docs last looked. Never further back than 100 commits, on purpose: the docs
# follow recent work, and the current files are the truth for everything older.
#
#   sh .cursor/skills/tech-docs/scripts/context.sh
#       the window (100 commits), the range (since docs/tech-docs/built-from, or the whole window),
#       each commit's docs and code, the files that moved most, the .env.example and compose diff,
#       and the words added to docs/*.md
#   sh .cursor/skills/tech-docs/scripts/context.sh --patch <pathspec>...
#       the range's patch for those paths, when the stats are not enough (api/src/chat.rs, frontend/src/infra)
#
# Commit subjects here are often one word ("added"), so the files a commit touched are the signal,
# and the long docs (docs/*.md) say what the change meant. Read those, not the whole code patch.
set -eu
cd "$(git rev-parse --show-toplevel)"

DOCS=docs/tech-docs
WINDOW=100
NEW_WORDS_LINES=400
KNOBS_LINES=150
CHURN_LINES=60

head=$(git rev-parse --short HEAD)
from=$([ -f "$DOCS/built-from" ] && tr -d '[:space:]' < "$DOCS/built-from" || true)
oldest=$(git rev-list --max-count="$WINDOW" HEAD | tail -n 1)

# the range: built-from..HEAD when built-from is one of the last 100 commits, else the whole window
if [ -n "$from" ] && git rev-list --max-count="$WINDOW" HEAD | grep -q "^$(git rev-parse --verify --quiet "$from^{commit}" || echo none)"; then
  commits=$(git rev-list "$from..HEAD")
  diffbase=$from
  note="since the docs last looked ($from)"
else
  commits=$(git rev-list --max-count="$WINDOW" HEAD)
  diffbase=$(git rev-parse --verify --quiet "$oldest^" || git hash-object -t tree /dev/null)
  if [ -n "$from" ]; then
    note="built-from $from is not one of the last $WINDOW commits: the whole window"
  else
    note="no $DOCS/built-from yet: the whole window"
  fi
fi
count=$(printf '%s\n' "$commits" | grep -c . || true)

# noise in a diff: lockfiles, media, build output
quiet() {
  git "$@" -- . ':!package-lock.json' ':!**/package-lock.json' ':!Cargo.lock' ':!random-media' ':!frontend/dist' ':!target'
}

if [ "${1-}" = "--patch" ]; then
  shift
  [ $# -gt 0 ] || { echo "usage: context.sh --patch <pathspec>..." >&2; exit 2; }
  echo "# patch $diffbase..$head ($count commits), $*"
  git diff "$diffbase" HEAD -- "$@"
  exit 0
fi

echo "# tech-docs context"
echo "built-from: ${from:-none}"
echo "head: $head"
echo "range: $count commits, $note"
echo "uncommitted: $(git status --porcelain | grep -c . || true) paths (not in any commit; the docs follow commits, say so if asked about them)"
echo

echo "## the window: the last $WINDOW commits, newest first"
git log --max-count="$WINDOW" --date=short --format='%h %ad %s'
echo

[ "$count" -gt 0 ] || { echo "## nothing new since $from. the docs are current."; exit 0; }

echo "## the range, by commit: the long docs and the code each one touched"
for sha in $commits; do
  git show --no-patch --date=short --format='--- %h %ad %s' "$sha"
  files=$(git show --name-only --format= "$sha" -- . ':!package-lock.json' ':!Cargo.lock' ':!random-media')
  docs=$(printf '%s\n' "$files" | grep -E '^docs/[^/]+\.md$' | sed 's|^docs/||' | tr '\n' ' ')
  code=$(printf '%s\n' "$files" | grep -Ev '^docs/' | grep . || true)
  n=$(printf '%s\n' "$code" | grep -c . || true)
  [ -n "$docs" ] && echo "    docs: $docs"
  if [ "$n" -gt 0 ]; then
    printf '    code: %s' "$(printf '%s\n' "$code" | head -n 6 | tr '\n' ' ')"
    [ "$n" -gt 6 ] && printf '(+%s more)' $((n - 6))
    echo
  fi
done
echo

echo "## the range, by file: what moved most (lines added+removed)"
quiet diff --numstat "$diffbase" HEAD | awk '$1 != "-" { print $1 + $2, $3 }' | sort -rn | head -n "$CHURN_LINES"
echo

echo "## knobs and boxes: .env.example and docker-compose.yml in the range"
knobs=$(git diff -U1 "$diffbase" HEAD -- .env.example docker-compose.yml | grep -Ev '^(index|diff --git)' || true)
ktotal=$(printf '%s\n' "$knobs" | grep -c . || true)
[ "$ktotal" -gt 0 ] && printf '%s\n' "$knobs" | head -n "$KNOBS_LINES" || echo "(unchanged)"
[ "$ktotal" -gt "$KNOBS_LINES" ] && echo "(... $((ktotal - KNOBS_LINES)) more lines cut. read .env.example and docker-compose.yml themselves: they are commented)"
echo

echo "## new words in docs/*.md in the range (added runs only; the current file is the whole truth, read it for the topics you rewrite)"
words=$(git diff -U0 --word-diff=porcelain "$diffbase" HEAD -- 'docs/*.md' | grep -E '^\+' | grep -Ev '^\+\+\+ /dev/null' | sed 's/^+++ b\//=== /')
total=$(printf '%s\n' "$words" | grep -c . || true)
printf '%s\n' "$words" | head -n "$NEW_WORDS_LINES"
[ "$total" -gt "$NEW_WORDS_LINES" ] && echo "(... $((total - NEW_WORDS_LINES)) more lines cut. read the current docs/*.md named above instead)"
exit 0
