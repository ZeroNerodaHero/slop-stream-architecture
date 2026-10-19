#!/bin/sh
# Publish the build in /dist into /srv, the volume caddy serves, so a page loaded
# mid-deploy never meets a half-written index.html or one that points at js that
# is not there yet:
#   1. copy the build into a temp dir on the same volume, so every step below is
#      a rename, never a write caddy could read halfway through
#   2. rename everything but index.html into place. assets carry a hash in the
#      name, so these are new files; the old build's stay for whoever is on it
#   3. rename index.html over the old one. rename is atomic: old page or new page
#   4. then remove what the new build no longer has
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
