#!/usr/bin/env node
/**
 * Stands in for the `gh` CLI in the end-to-end tests, so pull request reviews run offline and
 * nothing is ever sent to GitHub.
 *
 * Every call, with what was piped to it, is appended to `$JURY_FAKE_DIR/gh-calls.jsonl`. A
 * test scripts answers in `$JURY_FAKE_DIR/gh-replies.json`:
 *
 *   [{ "match": "^pr view 7 ", "stdout": "{…}", "code": 0 }]
 *
 * `match` is a regular expression tried against the arguments joined by spaces; the first hit
 * wins. `--version` and `auth status` always succeed; anything else unscripted fails, the way
 * `gh` does when it cannot find what it was asked for.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const line = args.join(' ');
const dir = process.env.JURY_FAKE_DIR;

const stdin = fs.readFileSync(0, 'utf8');
if (dir) fs.appendFileSync(path.join(dir, 'gh-calls.jsonl'), JSON.stringify({ args, stdin }) + '\n');

if (args[0] === '--version') {
  console.log('gh version 0.0.0 (fake gh)');
  process.exit(0);
}
if (line === 'auth status') process.exit(0);

let replies = [];
try {
  replies = JSON.parse(fs.readFileSync(path.join(dir ?? '', 'gh-replies.json'), 'utf8'));
} catch {
  // Nothing scripted.
}

const reply = replies.find((entry) => new RegExp(entry.match).test(line));
if (!reply) {
  process.stderr.write(`fake gh: no reply scripted for: ${line}\n`);
  process.exit(1);
}
process.stdout.write(reply.stdout ?? '');
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.code ?? 0);
