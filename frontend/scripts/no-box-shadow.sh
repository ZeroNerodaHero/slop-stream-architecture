#!/bin/sh
# The site has no box shadows (.cursor/rules/no-box-shadow.mdc). This fails when the pages' source
# has one: a tailwind `shadow-*` class behind any variant prefix (`drop-shadow-*` is not one, see the
# rule), a css `box-shadow:` declaration, or a `boxShadow:` with a value in a style object. Code
# forms only: prose may name the rule file or quote a class in backticks. `npm run lint` and
# `npm run build` run it over the tree; the cursor hook (.cursor/hooks/no-box-shadow.sh) runs it
# over one edit's text with `-`, read from stdin. Prints the offending lines; exit 1 when there are any.
set -u
pattern="(^|[\"'[:space:]:])shadow-|box-shadow[[:space:]]*:|boxShadow: *[\"'\`]"

if [ "${1-}" = "-" ]; then
  grep -En "$pattern" && exit 1
  exit 0
fi

cd "$(dirname "$0")/.." || exit 2
set -- src index.html tailwind.config.ts
# the api's hand-written pages (profile.rs's watch card, monitor.html) wear the same look. not in
# the frontend's docker build context, so only when it is there
[ -d ../api/src ] && set -- "$@" ../api/src
if grep -rEn "$pattern" "$@"; then
  echo "no box shadows on this site (.cursor/rules/no-box-shadow.mdc)" >&2
  exit 1
fi
