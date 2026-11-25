#!/bin/sh
set -u
pattern="(^|[\"'[:space:]:])shadow-|box-shadow[[:space:]]*:|boxShadow: *[\"'\`]"
allowed='^(src/app/globals\.css:)?[0-9]+:[[:space:]]*box-shadow: var\(--sidebar-edge-shadow\);$'

if [ "${1-}" = "-" ]; then
  grep -En "$pattern" | grep -Ev "$allowed" && exit 1
  exit 0
fi

cd "$(dirname "$0")/.." || exit 2
set -- src index.html tailwind.config.ts
[ -d ../api/src ] && set -- "$@" ../api/src
if grep -rEn "$pattern" "$@" | grep -Ev "$allowed"; then
  echo "no box shadows on this site (.cursor/rules/no-box-shadow.mdc)" >&2
  exit 1
fi
