#!/bin/sh
# Refuses an edit that would put one of the browser's own pickers into the pages
# (.cursor/skills/no-native-select/SKILL.md): the check `npm run build` makes
# (frontend/scripts/no-native-select.sh), heard at the edit instead of at the build. Only the
# files the build checks: the docs and the skill may show the tag.
# Anything it cannot read (another tool's shape, no jq) is allowed through; the build still catches it.
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.path // .tool_input.file_path // .tool_input.target_file // empty' 2>/dev/null)
case "$path" in
  */frontend/src/* | */frontend/index.html) ;;
  frontend/src/* | frontend/index.html) ;;
  *)
    echo '{"permission":"allow"}'
    exit 0
    ;;
esac
text=$(printf '%s' "$input" | jq -r '.tool_input.contents // .tool_input.new_string // .tool_input.content // empty' 2>/dev/null)
if found=$(printf '%s\n' "$text" | sh frontend/scripts/no-native-select.sh -); then
  echo '{"permission":"allow"}'
  exit 0
fi
jq -n --arg found "$found" '{
  permission: "deny",
  user_message: ("no browser pickers on this site (.cursor/skills/no-native-select/SKILL.md). the edit adds one:\n" + $found),
  agent_message: ("Refused: the edit adds one of the browser'"'"'s own pickers (a select, option, optgroup or datalist tag), and this site draws its own. Use Select from @/shared-components/Select (id, label, value, options, onChange); read .cursor/skills/no-native-select/SKILL.md first. The lines:\n" + $found)
}'
exit 0
