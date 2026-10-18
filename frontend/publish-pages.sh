#!/bin/sh
# Copy the new build into /srv, then drop files the new build no longer has.
# New files land first, so a page loaded mid-deploy still finds its old js
# until the next index.html points at the new one.
set -e
cp -a /dist/. /srv/
cd /srv
find . -type f | while read -r f; do
  [ -e "/dist/$f" ] || rm -f "$f"
done
echo "pages published: $(find /srv/assets -type f | wc -l) assets"
