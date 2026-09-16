#!/usr/bin/env bash
# Absence probe for a deployment: proves that what must not be public is not.
#
#   bash tools/probe.sh https://spring-bloom-xxxx.vercel.app
#
# Three things make the answer trustworthy (see docs/solutions/security-issues/
# working-notes-served-from-deploy-root.md): a control request that must be
# 200 (otherwise Vercel's bot wall is answering and the run is inconclusive),
# an exact 404 for every forbidden path (a 403 is not "gone"), and a browser
# user agent so the checker sees what a person sees.
set -u
BASE="${1:?base url}"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
# The pause between requests keeps Vercel's bot wall asleep: a fast burst of
# twenty requests turned every later answer into a 403 on the first run.
get () { sleep 0.5; curl -sL -A "$UA" -o /dev/null -w '%{http_code}' "$BASE/$1"; }

CONTROL=$(get '')
if [ "$CONTROL" != "200" ]; then echo "INCONCLUSIVE: control returned $CONTROL"; exit 2; fi
echo "control / -> 200"

FAIL=0
for p in tools/extract.py tools/layers.py tools/probe.sh tools/masks/04.json scripts/gen-audio.mjs \
         source/spring-bloom-inside.pdf source/cover.jpg work/ work/layers/04-sheet.png \
         CONTRACTS.md README.md NOTES.md reel/tour.json reel/index.html .env .env.local .vercelignore .gitignore package.json; do
  CODE=$(get "$p")
  if [ "$CODE" != "404" ]; then echo "EXPOSED OR UNKNOWN: /$p -> $CODE"; FAIL=1; else echo "ok 404 /$p"; fi
done

for p in index.html js/app.js css/site.css assets/spreads/04-left.webp assets/timings/spread-04.json assets/audio/spread-04.mp3 assets/layers/04/layers.json; do
  CODE=$(get "$p")
  if [ "$CODE" != "200" ]; then echo "MISSING: /$p -> $CODE"; FAIL=1; else echo "ok 200 /$p"; fi
done
[ "$FAIL" = 0 ] && echo "PROBE PASSED" || { echo "PROBE FAILED"; exit 1; }
