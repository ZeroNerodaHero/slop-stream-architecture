#!/bin/sh
set -e
cd /srv
tmp="$(mktemp -d /srv/.publish-XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
cp -a /dist/. "$tmp"/
(cd "$tmp" && find . -type f ! -path ./index.html) | while read -r f; do
  mkdir -p "$(dirname "$f")"
  mv -f "$tmp/$f" "$f"
done
mv -f "$tmp/index.html" index.html
find . -path "./${tmp##*/}" -prune -o -type f -print | while read -r f; do
  [ -e "/dist/$f" ] || rm -f "$f"
done
echo "pages published: $(find /srv/assets -type f | wc -l) assets"
