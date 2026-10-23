#!/usr/bin/env node
/**
 * Stands in for the `gh` CLI in the end-to-end tests, so nothing reaches GitHub.
 *
 * Every call is appended to `$JURY_FAKE_DIR/gh-calls.jsonl`, so a test can assert what was
 * sent. A test scripts answers by writing `$JURY_FAKE_DIR/gh-replies.json`:
 *
 *   [{ "match": "comments/7/replies", "reply": "{\"id\": 8, …}" }]
 *
 * `match` is a regular expression tried against the arguments joined by spaces; the first hit
 * wins. Anything unscripted fails, the way `gh` does when it cannot do what it was asked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('gh version 0.0.0 (fake gh)');
  process.exit(0);
}
const dir = process.env.JURY_FAKE_DIR;
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';

if (dir) fs.appendFileSync(path.join(dir, 'gh-calls.jsonl'), JSON.stringify({ args, input }) + '\n');

const reply = scripted();
if (reply === undefined) {
  process.stderr.write(`fake gh: nothing scripted for: ${args.join(' ')}\n`);
  process.exit(1);
}
process.stdout.write(reply);

function scripted() {
  if (!dir) return undefined;
  let replies;
  try {
    replies = JSON.parse(fs.readFileSync(path.join(dir, 'gh-replies.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const text = args.join(' ');
  return replies.find((entry) => new RegExp(entry.match).test(text))?.reply;
}
