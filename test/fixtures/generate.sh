#!/usr/bin/env bash
# Regenerate the diff fixtures from real git output.
# Hand-written fixtures drift from what git actually produces; these do not.
set -euo pipefail

out="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$tmp"
git init -q -b main .
git config user.email fixture@example.com
git config user.name Fixture
git config diff.renames true

DIFF=(git -c core.quotePath=false diff --no-color --no-ext-diff --find-renames --find-copies --src-prefix=a/ --dst-prefix=b/ -U3)

commit() { git add -A; git commit -q -m "$1"; }

# --- modify -----------------------------------------------------------------
printf 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n' > modify.txt
commit base
printf 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\nEIGHT\n' > modify.txt
"${DIFF[@]}" > "$out/modify.diff"
commit modify

# --- add / delete -----------------------------------------------------------
printf 'alpha\nbeta\n' > added.txt
git rm -q modify.txt
"${DIFF[@]}" HEAD > /dev/null
git add -A
git -c core.quotePath=false diff --no-color --no-ext-diff --find-renames --src-prefix=a/ --dst-prefix=b/ -U3 --cached HEAD > "$out/add-delete.diff"
commit "add and delete"

# --- pure rename ------------------------------------------------------------
git mv added.txt renamed.txt
git add -A
"${DIFF[@]}" --cached HEAD > "$out/rename-pure.diff"
commit rename

# --- rename with edits ------------------------------------------------------
printf 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n' > renamed.txt
commit grow
git mv renamed.txt moved.txt
printf 'alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n' > moved.txt
git add -A
"${DIFF[@]}" --cached HEAD > "$out/rename-edit.diff"
commit "rename with edits"

# --- mode change ------------------------------------------------------------
chmod +x moved.txt
"${DIFF[@]}" > "$out/mode.diff"
commit chmod

# --- binary -----------------------------------------------------------------
printf '\x00\x01\x02binary\x00' > blob.bin
git add -A
"${DIFF[@]}" --cached HEAD > "$out/binary.diff"
commit binary

# --- no newline at end of file ---------------------------------------------
printf 'first\nsecond' > nonewline.txt
git add -A
"${DIFF[@]}" --cached HEAD > "$out/nonewline-add.diff"
commit "no newline"
printf 'first\nsecond\n' > nonewline.txt
"${DIFF[@]}" > "$out/nonewline-fixed.diff"
commit "add trailing newline"

# --- CRLF -------------------------------------------------------------------
printf 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n' > crlf.txt
git add -A
commit crlf
printf 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\n' > crlf.txt
"${DIFF[@]}" > "$out/crlf.diff"
commit "crlf edit"

# --- empty file -------------------------------------------------------------
: > empty.txt
git add -A
"${DIFF[@]}" --cached HEAD > "$out/empty-file.diff"
commit empty

# --- path with spaces -------------------------------------------------------
printf 'x\ny\nz\n' > "a file with spaces.txt"
git add -A
"${DIFF[@]}" --cached HEAD > "$out/paths-spaces.diff"
commit spaces

# --- two identical hunks in one file ---------------------------------------
printf 'head\nkeep\nA\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nA\nkeep\ntail\n' > duplicate.txt
commit "duplicate base"
printf 'head\nkeep\nB\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nkeep\nB\nkeep\ntail\n' > duplicate.txt
"${DIFF[@]}" > "$out/duplicate-hunks.diff"
commit duplicate

# --- several files in one diff ---------------------------------------------
printf 'a\nb\nc\nd\ne\nf\n' > one.txt
printf 'a\nb\nc\nd\ne\nf\n' > two.txt
printf 'a\nb\nc\nd\ne\nf\n' > three.txt
commit "multi base"
printf 'a\nB\nc\nd\ne\nf\n' > one.txt
printf 'a\nb\nc\nD\ne\nf\n' > two.txt
git rm -q three.txt
printf 'new\n' > four.txt
git add -A
"${DIFF[@]}" --cached HEAD > "$out/multi.diff"

echo "wrote fixtures to $out"
