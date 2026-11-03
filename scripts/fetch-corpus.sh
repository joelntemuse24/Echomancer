#!/usr/bin/env bash
# Fetch the chapter-detection corpus into $CORPUS_DIR (default /tmp/echomancer-corpus).
#
# Every source is public domain or freely licensed. Nothing here is committed to
# the repo; the script is, so the corpus can be rebuilt on any machine.
#
#   ./scripts/fetch-corpus.sh            # download what is missing
#   ./scripts/fetch-corpus.sh --force    # re-download everything
#
# The manifest is scripts/corpus-manifest.tsv:
#   id <TAB> format <TAB> url <TAB> note
#
# Formats: txt, epub, pdf, html
# Standard Ebooks needs `?source=download` or it serves an interstitial page.
set -uo pipefail

DIR="${CORPUS_DIR:-/tmp/echomancer-corpus}"
MANIFEST="$(dirname "$0")/corpus-manifest.tsv"
FORCE="${1:-}"
mkdir -p "$DIR"

UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
ok=0; skipped=0; failed=0

while IFS=$'\t' read -r id fmt url note; do
  case "$id" in ''|'#'*) continue ;; esac
  out="$DIR/$id.$fmt"
  if [ -s "$out" ] && [ "$FORCE" != "--force" ]; then
    skipped=$((skipped+1)); continue
  fi
  code=$(curl -sSL --max-time 120 --retry 2 --retry-delay 2 \
    -A "$UA" -o "$out" -w "%{http_code}" "$url" 2>/dev/null || echo 000)
  size=$(wc -c < "$out" 2>/dev/null || echo 0)
  # A real document is at least a few kilobytes; an error page is small.
  if [ "$code" = "200" ] && [ "$size" -gt 2000 ]; then
    ok=$((ok+1)); printf '  ok   %-28s %8s bytes  %s\n' "$id.$fmt" "$size" "$note"
  else
    failed=$((failed+1)); printf '  FAIL %-28s http=%s size=%s  %s\n' "$id.$fmt" "$code" "$size" "$url"
    rm -f "$out"
  fi
done < "$MANIFEST"

echo
echo "corpus: $ok fetched, $skipped already present, $failed failed  ($DIR)"
[ "$failed" -eq 0 ]
