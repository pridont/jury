#!/usr/bin/env node
/**
 * Stands in for the `claude` CLI in the end-to-end tests: free, offline, and the same answer
 * every time.
 *
 * Every call is appended to `$JURY_FAKE_DIR/calls.jsonl`, so a test can assert what was sent.
 * A test can script an answer by writing `$JURY_FAKE_DIR/replies.json`:
 *
 *   [{ "match": "organise code reviews", "reply": "{\"summary\": …}" }]
 *
 * `match` is a regular expression tried against the system prompt and the input; the first
 * hit wins. Anything unscripted gets a canned answer that satisfies the prompt's contract.
 * An entry may also set `delayMs`, to answer slowly, and `exit` with `stderr`, to fail the
 * way the real CLI does.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0 (fake claude)');
  process.exit(0);
}

const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const dir = process.env.JURY_FAKE_DIR;
const input = fs.readFileSync(0, 'utf8');
const system = flag('--system-prompt') ?? '';
const streaming = flag('--output-format') === 'stream-json';

if (dir) fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, system, input }) + '\n');

const entry = scripted();
if (entry?.delayMs) await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
if (entry?.exit) {
  process.stderr.write(entry.stderr ?? 'fake failure');
  process.exit(entry.exit);
}
const reply = entry?.reply ?? canned();

if (streaming) {
  const session = flag('--resume') ?? 'fake-session';
  const emit = (line) => process.stdout.write(JSON.stringify(line) + '\n');
  emit({ type: 'system', subtype: 'init', session_id: session });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  emit({ type: 'result', subtype: 'success', session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });
} else {
  process.stdout.write(
    JSON.stringify({ subtype: 'success', result: reply, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 }),
  );
}

function scripted() {
  if (!dir) return undefined;
  let replies;
  try {
    replies = JSON.parse(fs.readFileSync(path.join(dir, 'replies.json'), 'utf8'));
  } catch {
    return undefined;
  }
  const text = `${system}\n${input}`;
  return replies.find((candidate) => new RegExp(candidate.match).test(text));
}

function canned() {
  if (system.includes('organise code reviews')) return cluster();
  // No questions unless a test scripts some: an answer with none is declined, and nothing shows.
  if (system.includes('prepare a reviewer to read a change')) return JSON.stringify({ cohorts: [] });
  if (system.includes('summarise diffs')) {
    return JSON.stringify({ summary: `Fake summary of ${input.match(/^File: (.+)$/m)?.[1] ?? 'the file'}.` });
  }
  return 'Fake answer.';
}

/**
 * Two cohorts, files in reverse digest order, so a test can tell the model's grouping from
 * the by-file fallback. Two, because `merge` declines everything-in-one.
 */
function cluster() {
  const files = [];
  for (const line of input.split('\n')) {
    const heading = line.match(/^## (.+?)(?: \((?:added|deleted|renamed|copied)\))?$/);
    if (heading) files.push({ path: heading[1], labels: [] });
    const label = line.match(/^(h\d+)\b/);
    if (label && files.length > 0) files.at(-1).labels.push(label[1]);
  }
  files.reverse();

  const half = Math.ceil(files.length / 2);
  const groups = files.length > 1 ? [files.slice(0, half), files.slice(half)] : [files];
  return JSON.stringify({
    summary: 'Fake walkthrough summary.',
    cohorts: groups.map((group, i) => ({
      id: `c${i + 1}`,
      title: `Fake cohort ${i + 1}`,
      summary: `Fake cohort ${i + 1} summary.`,
      kind: 'feature',
      risk: 'low',
      layers: group.map((file, j) => ({
        id: `c${i + 1}l${j + 1}`,
        title: `Fake layer ${file.path}`,
        summary: '',
        hunks: file.labels,
      })),
    })),
    notes: [],
  });
}
