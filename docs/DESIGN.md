# Design

How Jury is put together, and the reasoning behind the parts where a different
choice would have been easy.

## Concepts

- **Hunk** — a contiguous diff block. The atom, and the unit that gets ticked.
- **Layer** — an ordered set of hunks forming one step of the reading. Routinely spans files.
- **Cohort** — related layers, in reading order. What the tree lists.
- **Scaffolding** — hunks classified as generator output. Present and reachable, but out of
  the reading order and out of the token budget.

Array position *is* the order, at both levels. There is no dependency graph and no
topological sort: the model has to reason about order anyway to write a coherent
walkthrough, so it emits that order directly, which removes a whole class of cycle-detection
bugs.

## The pipeline

```
git diff ─→ parse ─→ classify ─→ heuristic cohorts ─→ on screen
                                          │
                                          ├─ pass 1: a sentence per file      (Haiku)
                                          └─ pass 2: cohorts and order        (Sonnet)
                                                        │
                                                     merge ─→ replaces the stack, once
```

The heuristic stack is navigable before a request is sent. Every model pass improves
something already on screen, and nothing waits on one.

## Hunk identity

`sha256(path + NUL + changed lines)`, trailing whitespace stripped, context and `@@` headers
excluded. Content-based, never positional. A hunk keeps its identity when code above it
moves, and loses it the moment its own content changes.

Two identical hunks in one file collide and are disambiguated by ordinal, so each stays
independently reviewable. A change with no textual hunks — binary, pure rename, chmod, added
empty file — gets one synthetic hunk, because a change that cannot be listed cannot be
reviewed.

## Marks and notes take opposite trades

Refresh computes one set of anchors: `exact`, `moved` (same file, ≥80% similar), or
`orphaned`. What the two callers do with a `moved` match is where they differ.

A **mark** refuses it. A hunk that changed comes back unreviewed however similar it looks,
because a tick that survives an edit is a lie, and a lie about what has been reviewed is
worse than having no marks.

A **note** accepts it and carries a flag. Losing the note entirely is worse than showing it
two lines off, and the flag says not to trust the position.

Similarity compares added lines only with added lines — otherwise a line and its own deletion
vouch for each other, and an edit scores identical to its own reversal. Identical lines match
first; the remainder pairs by shared prefix and suffix, which is what makes the measure work
on a one-line change that later gained a clause.

## The model proposes, merge disposes

Any pass-2 output, however malformed, either becomes a complete partition of the hunk set or
is declined outright. Invented labels are dropped, repeats keep their first home, empty
layers go, and whatever went unplaced lands in a trailing `Unclassified` cohort.

Declined: everything in one cohort, one cohort per file, or most of the diff unplaced. A
wrong answer that looks like an answer is worse than no answer, so the heuristic stack stays.
A declined answer is never cached — a schema-valid non-answer cached is a known-bad result
replayed on every open — and a cached answer is judged again on the way out.

Hunks are labelled `h1`, `h2` in the digest: short to write back, and an invented label is
obviously invalid rather than plausibly real. Any that leak into prose are replaced with the
file they stand for before a reader sees them.

## The digest

Per hunk: label, path, enclosing symbol, ±counts, and a sample of changed lines, plus
whatever pass 1 said about each file. Detail is shed as the budget tightens — samples shrink,
then go — but never structure. **A hunk the model never sees is a hunk it cannot place**, and
an unplaced hunk is one the reviewer might never be shown.

## Scaffolding, in order of trust

1. `.gitattributes` says `linguist-generated` or `-diff`.
2. The file says so about itself — `@generated`, `was generated with`.
3. Lockfiles, vendored trees, build output.
4. Workspace project config, in a repository that actually has generators.
5. A directory arriving whole with generator-shaped config among at least three new files.
   Only the config is claimed; the code in a new library is what the reviewer is there for.
6. Content shape: all additions, 200+ lines, and either under 15% distinct lines or a line
   over 2000 characters.
7. An added markdown file with nothing under its headings but metadata.

Precision beats recall throughout. Misclassifying hand-written code hides a review;
missing one generated file costs nothing. Every verdict carries a reason, is always shown,
and is one click from being reversed — remembered per repository.

## Providers

One interface, two implementations. Prompts are prose and a JSON shape with no model dialect
in them, and tools are named by capability (`readFile`, `search`) rather than by product, so
each adapter maps them to whatever it has — or declares it has none, and the feature degrades
visibly instead of quietly getting worse.

The second adapter exists to test the first. It found two things: `vscode.lm` has no
conversation handle, so `Answer.session` is optional and a follow-up there resends context;
and it cannot run repository tools, so Ask says so in its own answer rather than being
silently worse than the alternative.

The registry above the interface owns the queue, the disk cache, JSON repair, and
cancellation. Adapters call, parse, report.

## Calling a model

Through the `claude` CLI the user is signed in to. `--setting-sources ""` keeps their
settings, their hooks and **the reviewed repository's `CLAUDE.md`** out of every call: a
repository under review is data, not instructions. `--system-prompt` replaces the CLI's agent
instructions rather than appending to them. `--tools ""` makes the structured tier a plain
model call.

Answers are cached on disk under `.git/`, keyed by prompt version, model and input, and
written only once the caller has accepted them. Editing a prompt invalidates exactly the
answers that prompt produced.

Bad JSON is first repaired locally — a raw newline inside a string, a trailing comma — then,
if that fails, sent back to the model *with the broken answer* and asked for it corrected.
Sending the question again instead would cost the same and change nothing.

Every child process is tracked. Closing a review cancels what it started; an exit guard on
the extension host catches a shutdown that skips disposal, because a spawned process outlives
its parent and would otherwise keep talking to the user's account.

## State

`<git-common-dir>/jury/<reviewId>.json`, written atomically. Inside `.git`, so it is
never committed and never dirties the working tree, and shared by every worktree.

Keyed by the **spec**, not by resolved revisions: a review of `main...HEAD` has to survive
main moving on, or every push would silently start over.

## Layout

```
src/
  git/        repo resolution, diff acquisition, unified diff parser, hunk identity
  model/      types, scaffolding classifier, heuristic grouping, merge, reading order
  agent/      provider interface, adapters, queue, cache, JSON hygiene, digest, prompts
  state/      persistence and re-anchoring
  ui/         tree, diff editor, navigation, comments, chat, walkthrough, documents
  github/     pull requests and review submission
test/
  unit/       everything above, plus fixtures generated from real git
  eval/       grouping and order scored against hand-written expectations
```

## Deliberately not done

- **Commit-by-commit review.** A different mental model that would fork the whole UI.
- **Writing patches.** The moment it edits, it stops being a review tool. The read-only tool
  set is a constraint, not a default.
- **A webview.** The editor's own diff, comments and chat are better than reimplementations,
  and they come with LSP.
