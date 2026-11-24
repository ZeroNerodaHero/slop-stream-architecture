#!/bin/sh
set -u
pattern="(^|[\"'[:space:]:])shadow-|box-shadow[[:space:]]*:|boxShadow: *[\"'\`]"

if [ "${1-}" = "-" ]; then
  grep -En "$pattern" && exit 1
  exit 0
fi

cd "$(dirname "$0")/.." || exit 2
set -- src index.html tailwind.config.ts
[ -d ../api/src ] && set -- "$@" ../api/src
if grep -rEn "$pattern" "$@"; then
  echo "no box shadows on this site (.cursor/rules/no-box-shadow.mdc)" >&2
  exit 1
fi
