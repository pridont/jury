# Change Stack

Review a diff in VS Code as an **ordered stack of logical changes** instead of an
alphabetical list of files. A model groups and orders the change and writes the summaries;
you judge the code.

> Status: **V6 — the reordering works.** Open a diff and a model groups it into cohorts by
> intent and puts them in dependency-first reading order, with a walkthrough to read first.
> Walk every hunk with one key, tick what you have read, leave notes, export them, and
> refresh after the author pushes again. See [docs/PLAN.md](docs/PLAN.md).

```
Change Stack: Review Working Tree     uncommitted work, untracked files included
Change Stack: Review Staged Changes   the index
Change Stack: Review This Branch…     what this branch introduced, against a merge base
```

`alt+j` walks every hunk in the review, crossing files, layers and cohorts on its own.
`alt+m` ticks the hunk under the cursor, `alt+shift+m` the whole layer. `alt+z` hides
everything but the code.

Progress is stored in `.git/`, so it survives quitting, and it survives a rebase: marks are
keyed by content, not by line number. A hunk that actually changed comes back unreviewed —
a tick that outlives an edit would be a lie — and refresh says exactly what it did.

Notes are left on the diff itself and anchored the same way. They make the opposite trade
from marks: a note follows code that moved and says its position is approximate, because
losing it entirely would be worse. Notes whose code is gone are listed for you to re-pin or
discard. `Export Review as Markdown` writes the whole thing out, grouped by cohort.

Files arrive in alphabetical order, which is almost never the order that makes a change
comprehensible: you read the caller before the callee and the test before the thing it
tests. Change Stack reorganises the diff into **cohorts** of related work, each split into
**layers** in dependency-first reading order — introduce the thing, then the change that
needed it, then the plumbing, then the tests.

Everything renders in VS Code's own surfaces: the built-in diff editor, the Comments API,
the tree view. Real syntax highlighting, real LSP, real go-to-definition, your keybindings.

## Is the ordering any good?

`npm run eval` answers that with a number instead of an opinion. It scores two things over
pairs of hunks against a hand-written expectation — **grouping** (do the two agree these
belong together) and **order** (are hunks in different cohorts read in the expected
sequence) — and prints both next to the heuristic, which is what clustering has to beat to
be worth anything.

| | auth-clock | two-changes |
|---|---|---|
| grouping (model) | 100.0% | 100.0% |
| grouping (heuristic) | 80.0% | 60.9% |
| order (model) | 100.0% | 100.0% |
| order (heuristic) | 77.8% | 100.0% |

Two fixtures is thin evidence, and each figure is one sample. The harness exists so the next
prompt change is measured rather than argued about, and it has already earned that twice:
keeping a documentation hunk with the change it documents moved `two-changes` grouping from
87.0% to 91.3%, and tightening what the overview is asked for took both fixtures to 100%.
Whether that second move was the prompt or the variance, a single run cannot say.

## Design principles

- **Ordering is the product.** If the order is not better than alphabetical, nothing else
  matters.
- **AI failure degrades quality, never availability.** Turn the model off, or have no
  provider installed, and the review still works — grouped by file, with marks and comments
  intact.
- **A tick that survives an edit is a lie.** Review marks are carried only by an exact
  content match, so a hunk that changed comes back unreviewed.
- **Read-only.** A review tool must never edit the code it is reviewing.
- **Generated code is not review material.** Lockfiles, Nx generator output and anything
  marked `@generated` are collected out of the reading order and out of the token budget —
  always with the reason shown, and always one click from coming back.

## Ask

`@changestack` in the chat view answers questions about the change under the cursor — or the
whole step, with `/step`. It reads the repository to answer, and shows you when it does, so
a pause has a visible reason:

```
› Grep hunkId
Yes. hunkId() is called in src/git/parse.ts, outside identity.ts.
```

Read-only, always: a review tool must never edit the code it is reviewing. Follow-ups resume
the same conversation rather than resending the diff — 10,353 input tokens for the first
question, 10 for the next.

## Providers

Two, so far. **claude** goes through the CLI you are already signed in to — no API key — and
can read the repository while answering. **vscode-lm** uses your editor's own chat models
(Copilot and anything else installed): no subprocess, no PATH, but it cannot read the
repository yet, so Ask answers from the diff alone and says so.

Passes route independently — summaries are many small calls, clustering is the one call that
decides the reading order:

```jsonc
"changestack.passes": { "summaries": "vscode-lm", "clustering": "claude" }
```

Choosing a provider is choosing where the code under review is sent, and the setting says so.

## Development

```
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm run check      # typecheck
npm test           # unit tests
```

Press `F5` to launch an Extension Development Host. `Change Stack: Doctor` reports git, `gh`,
`claude` and their sign-in state.
