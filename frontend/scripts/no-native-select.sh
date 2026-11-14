#!/bin/sh
# The site draws its own pickers (.cursor/skills/no-native-select/SKILL.md): a list to pick one
# option from is `Select` (src/shared-components/Select.tsx), never the browser's, whose open
# list is the operating system's and takes no css. This fails when the pages' source has the
# browser's: a `select`, `option`, `optgroup` or `datalist` tag, or one made with createElement.
# Code forms only: prose may name the tag without its bracket. `npm run lint` and `npm run build`
# run it over the tree; the cursor hook (.cursor/hooks/no-native-select.sh) runs it over one
# edit's text with `-`, read from stdin. Prints the offending lines; exit 1 when there are any.
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
