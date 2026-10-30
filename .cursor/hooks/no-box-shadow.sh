#!/bin/sh
# Refuses an edit that would put a box shadow into the pages (.cursor/rules/no-box-shadow.mdc): the
# check `npm run build` makes (frontend/scripts/no-box-shadow.sh), heard at the edit instead of at
# the build. Only the files the build checks: the docs and the rules may name a shadow class.
# Anything it cannot read (another tool's shape, no jq) is allowed through; the build still catches it.
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.path // .tool_input.file_path // .tool_input.target_file // empty' 2>/dev/null)
case "$path" in
  */frontend/src/* | */frontend/index.html | */frontend/tailwind.config.ts | */api/src/*) ;;
  frontend/src/* | frontend/index.html | frontend/tailwind.config.ts | api/src/*) ;;
  *)
    echo '{"permission":"allow"}'
    exit 0
    ;;
esac
text=$(printf '%s' "$input" | jq -r '.tool_input.contents // .tool_input.new_string // .tool_input.content // empty' 2>/dev/null)
if found=$(printf '%s\n' "$text" | sh frontend/scripts/no-box-shadow.sh -); then
  echo '{"permission":"allow"}'
  exit 0
fi
jq -n --arg found "$found" '{
  permission: "deny",
  user_message: ("no box shadows on this site (.cursor/rules/no-box-shadow.mdc). the edit adds one:\n" + $found),
  agent_message: ("Refused: the edit adds a box shadow and this site has none (.cursor/rules/no-box-shadow.mdc). A box is a 1px stroke; a hover is a colour or a border change. The lines:\n" + $found)
}'
exit 0
