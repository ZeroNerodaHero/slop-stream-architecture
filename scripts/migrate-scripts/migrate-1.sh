#!/usr/bin/env bash
# chat lines carry their account: `uid` on every login's line in the redis streams (docs/chat.md)
#
# A login's line (`v` 1) used to carry only the name it was said under. The face by a line is now
# looked up when the line is read, by account for a login's line (chat.rs `with_faces`), so a line
# without `uid` shows no face. This fills it in, once, on every `chat:*` stream: the account behind
# the name, from `streamers`, and from `held_names` for a line said under a name since renamed
# away. A name that is nobody's account any more is left as it is: no face, which is the truth.
#
# A stream entry cannot be edited in place, so a stream with such lines is rebuilt in one atomic
# EVAL: the same entries with the same ids, `uid` added where it was missing, the ttl kept. The
# room's reader (chat.rs) tails by id and sees nothing; an open tab keeps what it has drawn.
#
# Looks first: counts, in every stream, the login's lines without `uid` whose name has an account
# behind it, and touches nothing when there are none. --dry-run stops after the count.
. "$(dirname "$0")/lib.sh" "$@"

# a login's lines (v 1) with no uid, in one stream: those ARGV (name, id, name, id, ...) can
# fill, and those it cannot
COUNT_LUA='
local map = {}
for i = 1, #ARGV, 2 do map[ARGV[i]] = ARGV[i + 1] end
local fixable, unknown = 0, 0
for _, e in ipairs(redis.call("XRANGE", KEYS[1], "-", "+")) do
  local f, from, v, uid = e[2], nil, false, false
  for i = 1, #f, 2 do
    if f[i] == "from" then from = f[i + 1]
    elseif f[i] == "v" and f[i + 1] == "1" then v = true
    elseif f[i] == "uid" then uid = true end
  end
  if v and not uid then
    if from and map[from] then fixable = fixable + 1 else unknown = unknown + 1 end
  end
end
return {fixable, unknown}'

# the same stream again, uid added from ARGV (name, id, name, id, ...) where it was missing. the
# entries are read, the key dropped, and every entry put back under its own id (XADD takes an
# explicit id into an empty stream), then the ttl. one script: nothing can land in between
FILL_LUA='
local map = {}
for i = 1, #ARGV, 2 do map[ARGV[i]] = ARGV[i + 1] end
local key = KEYS[1]
local entries = redis.call("XRANGE", key, "-", "+")
local ttl = redis.call("PTTL", key)
local filled, unknown = 0, 0
redis.call("DEL", key)
for _, e in ipairs(entries) do
  local f, from, v, uid = e[2], nil, false, false
  for i = 1, #f, 2 do
    if f[i] == "from" then from = f[i + 1]
    elseif f[i] == "v" and f[i + 1] == "1" then v = true
    elseif f[i] == "uid" then uid = true end
  end
  if v and not uid then
    if from and map[from] then
      f[#f + 1] = "uid"; f[#f + 1] = map[from]; filled = filled + 1
    else
      unknown = unknown + 1
    end
  end
  redis.call("XADD", key, e[1], unpack(f))
end
if ttl > 0 then redis.call("PEXPIRE", key, ttl) end
return {filled, unknown}'

# the account behind each name: the accounts as they are named now, and the names an account
# left behind in a rename and still holds (docs/ids.md). a name two accounts have had (a hold
# that lapsed, then a new signup took it) is left out, so its lines are left alone
# read through $(...), not < <(...): set -e never sees a process substitution fail, so a failed
# psql would read as no accounts and the script would say "nothing to do"
rows="$(sql "SELECT name, min(id::text) FROM (SELECT name, id FROM streamers WHERE password_hash IS NOT NULL UNION ALL SELECT name, user_id FROM held_names) n GROUP BY name HAVING count(DISTINCT id) = 1")"
map=()
while read -r name id; do
  if [ -n "$name" ] && [ -n "$id" ]; then map+=("$name" "$id"); fi
done <<< "$rows"

# every room: a stream's `chat:<name>`, a channel's `chat:<server>/<channel>`. names have no
# spaces (the name rule), so one key per word is safe. the two numbers come on two lines, as
# redis-cli prints an array
keys="$(redis --scan --pattern 'chat:*' | sort -u)"
rooms=0; total=0; unknown=0; todo=()
for key in $keys; do
  rooms=$((rooms + 1))
  out="$(redis EVAL "$COUNT_LUA" 1 "$key" ${map[@]+"${map[@]}"})"
  n="$(sed -n 1p <<< "$out")"; u="$(sed -n 2p <<< "$out")"
  [[ "$n" =~ ^[0-9]+$ && "$u" =~ ^[0-9]+$ ]] || die "$key: redis said: $out"
  unknown=$((unknown + u))
  [ "$n" -gt 0 ] || continue
  todo+=("$key"); total=$((total + n))
done
if [ "$total" -eq 0 ]; then
  note "every login's line that can carry its account does ($rooms room(s) looked at, $(( ${#map[@]} / 2 )) name(s) with an account). nothing to do"
  [ "$unknown" -eq 0 ] || note "$unknown login's line(s) are under a name that is nobody's account any more: left as they are, with no face"
  exit 0
fi
note "$total login's line(s) to fill in ${#todo[@]} of $rooms room(s), from $(( ${#map[@]} / 2 )) name(s) with an account; $unknown under a name that is nobody's any more, left as they are"
if [ "$DRY" = 1 ]; then
  note "dry run: nothing changed"
  exit 0
fi

filled=0
for key in "${todo[@]}"; do
  out="$(redis EVAL "$FILL_LUA" 1 "$key" ${map[@]+"${map[@]}"})"
  f="$(sed -n 1p <<< "$out")"; u="$(sed -n 2p <<< "$out")"
  [[ "$f" =~ ^[0-9]+$ && "$u" =~ ^[0-9]+$ ]] || die "$key: redis said: $out"
  filled=$((filled + f))
  if [ "$u" = 0 ]; then note "$key: $f filled"; else note "$key: $f filled, $u left"; fi
done
note "done: $filled line(s) now carry their account"
