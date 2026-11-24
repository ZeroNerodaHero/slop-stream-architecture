#!/bin/sh
set -u
cd "$(git rev-parse --show-toplevel)"
DOCS=docs/tech-docs
URL=${TECH_DOCS_URL:-http://localhost:42069/tech-docs}
fail=0
bad() { echo "$1"; fail=1; }

[ -d "$DOCS" ] || { echo "no $DOCS yet"; exit 1; }
[ -f "$DOCS/index.html" ] || bad "$DOCS/index.html missing: the map every page links back to"
[ -f "$DOCS/style.css" ] || bad "$DOCS/style.css missing: the shared look and the animations"

if grep -rEin '<(img|video|audio|svg|canvas|iframe|object|embed|picture|source)[[:space:]>/]' "$DOCS"; then
  bad "media tags above: the docs are words and css, nothing drawn or fetched"
fi
if grep -rEn 'url\(' "$DOCS"; then
  bad "url() above: nothing is fetched into the docs, not a font, not a picture"
fi
if grep -rEn '<script|<link[^>]+href="(https?:)?//' "$DOCS" --include='*.html'; then
  bad "script or remote stylesheet above: a page carries no script (vite adds its own reload client when serving), and loads nothing from elsewhere"
fi
if grep -rEn "(^|[\"'[:space:]:])shadow-|box-shadow[[:space:]]*:|boxShadow: *[\"'\`]" "$DOCS"; then
  bad "box shadow above: none on this site (.cursor/rules/no-box-shadow.mdc). a box is a 1px stroke"
fi
if grep -rEn 'style="' "$DOCS" --include='*.html' | grep -Ev 'style="--[a-z]+: *[^";]+"'; then
  bad "style= above with more than one custom property in it: a page carries no css of its own. the only style= is one of --n, --t, --to for a class in style.css"
fi

for page in "$DOCS"/*.html; do
  name=$(basename "$page")
  grep -q '<title>' "$page" || bad "$name: no <title>"
  grep -q '<main' "$page" || bad "$name: no <main>"
  grep -q 'href="style.css"' "$page" || bad "$name: does not link style.css"
  if [ "$name" != "index.html" ]; then
    grep -q 'href="index.html"' "$page" || bad "$name: no link back to index.html"
    grep -q "href=\"$name\"" "$DOCS/index.html" || bad "$name: not on index.html, nobody can find it"
  fi
  grep -Eo '(href|src)="[^"]*"' "$page" | sed -E 's/^(href|src)="//; s/"$//' | while IFS= read -r target; do
    case "$target" in
      ''|'#'*|http://*|https://*|mailto:*) continue ;;
    esac
    file=${target%%#*}
    file=${file%%\?*}
    [ -f "$DOCS/$file" ] || echo "$name: $target points at nothing in $DOCS"
  done | grep . && fail=1
done

grep -q 'prefers-reduced-motion' "$DOCS/style.css" 2>/dev/null || bad "style.css: no prefers-reduced-motion block. every animation stops for whoever asked for less motion"

if [ -f "$DOCS/built-from" ]; then
  sha=$(tr -d '[:space:]' < "$DOCS/built-from")
  git rev-parse --verify --quiet "$sha^{commit}" > /dev/null || bad "built-from: $sha is not a commit this repo has"
else
  bad "$DOCS/built-from missing: the commit the docs last looked at (git rev-parse --short HEAD)"
fi

if curl -fsS -o /dev/null --max-time 3 "$URL/" 2>/dev/null; then
  for page in "$DOCS"/*.html; do
    name=$(basename "$page")
    code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$URL/$name")
    [ "$code" = "200" ] || bad "$URL/$name answered $code"
  done
  code=$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$URL/style.css")
  [ "$code" = "200" ] || bad "$URL/style.css answered $code"
  echo "served: $URL/ and every page answered 200"
else
  echo "dev server not answering at $URL (npm run dev in frontend/, SHOW_DOCS=1 in .env): the http check was skipped"
fi

[ "$fail" -eq 0 ] && echo "ok: $(ls "$DOCS"/*.html | wc -l | tr -d ' ') pages"
exit "$fail"
