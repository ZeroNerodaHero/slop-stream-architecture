#!/bin/sh
set -u
pattern="<(select|option|optgroup|datalist)([[:space:]/>]|\$)|createElement\\([[:space:]]*[\"'\`](select|option|optgroup|datalist)[\"'\`]"

if [ "${1-}" = "-" ]; then
  grep -En "$pattern" && exit 1
  exit 0
fi

cd "$(dirname "$0")/.." || exit 2
if grep -rEn "$pattern" src index.html; then
  echo "no browser pickers on this site: use Select (.cursor/skills/no-native-select/SKILL.md)" >&2
  exit 1
fi
