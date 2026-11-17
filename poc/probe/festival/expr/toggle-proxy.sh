#!/usr/bin/env bash
set -e
export BSK_HOME="C:/Users/i1290/.bsk"
export BSK_AUTO_START=0
export PATH="/c/Users/i1290/.local/bin:$PATH"
TAB=1673242212
bsk sync --session yyev --tab-id "$TAB" --json > .tmp/sync-toggle.json 2>&1
CTX=$(grep -o '"ctx": "[^"]*"' .tmp/sync-toggle.json | head -1 | cut -d'"' -f4)
bsk snapshot --session yyev --tab-id "$TAB" --json --max-tokens 30000 > .tmp/snap-toggle.json 2>&1
REF=$(grep -oE '@e[0-9]+ checkbox \\"自动接管取流[^\\]*' .tmp/snap-toggle.json | head -1 | grep -oE '@e[0-9]+')
echo "CTX=$CTX CHECKBOX=$REF"
if [ -z "$REF" ]; then echo "no checkbox ref"; exit 2; fi
bsk click --session yyev --tab-id "$TAB" --context "$CTX" \
  --expect '[{"target":"body","field":"exists","equals":true}]' "$REF" --json 2>&1 | head -c 1500
