# Change Stack

Review a diff in VS Code as an ordered stack of logical changes, not an alphabetical list of
files. A model groups the change and puts it in reading order; you judge the code.

Files arrive alphabetically, which is almost never the order that makes a change make sense —
you read the caller before the callee, the test before the thing it tests. Change Stack
regroups the diff into **cohorts** of related work, each split into **layers** in
dependency-first order: introduce the thing, then the change that needed it, then the
plumbing, then the tests.

Everything renders in VS Code's own surfaces — the diff editor, the Comments API, the tree.
Real syntax highlighting, real go-to-definition, your keybindings.

## Reviewing

| Command | What it reviews |
|---|---|
| Review Working Tree | uncommitted work, untracked files included |
| Review Staged Changes | the index |
| Review This Branch… | what this branch adds, against a merge base |
| Review a Pull Request… | by number, or the one on this branch |

| Key | |
|---|---|
| `alt+j` / `alt+k` | next / previous hunk — crosses files, layers and cohorts on its own |
| `alt+shift+j` / `alt+shift+k` | next / previous layer |
| `alt+m` / `alt+shift+m` | tick this hunk / this layer |
| `alt+a` / `alt+shift+a` | ask about this hunk / this layer |
| `alt+s` | the walkthrough |
| `alt+z` | hide everything but the code |

The walkthrough is what to read first: what the change does, in what order to read it, and
what deserves attention. A mermaid diagram appears when the change has a shape prose does not
show, which is rarely.

## Progress that survives

Marks live in `.git/`, keyed by content rather than line number. Quit and come back, or
refresh after a force-push: a hunk that moved keeps its tick, a hunk that **changed** comes
back unreviewed, and refresh says which — `refreshed · 5 marks kept · 2 changed · 1 gone`.
A tick that outlived an edit would be a lie.

Notes take the opposite trade. A note follows code that moved and says its position is
approximate, because losing it would be worse. A note whose code is gone is listed for you to
re-pin or discard, never dropped. `Export Review as Markdown` writes them out, grouped by
cohort, each with a `file:line`.

## Pull requests

The head is fetched into a ref of its own and reviewed against the merge base of its target
branch — what the author asked to have merged. Nothing is checked out; your working tree is
untouched. GitHub's "viewed" state comes across, so a review carries on where you left it.

`Submit Review to GitHub…` posts your notes as inline comments, after showing you the whole
payload — including what it will not send — and asking. A note already posted and unchanged
is not sent twice.

## Ask

`@changestack` in the chat view answers questions about the change under the cursor, or the
whole layer with `/step`. It reads the repository and shows you when it does, so a pause has
a visible reason:

```
› Grep hunkId
Yes. hunkId() is called in src/git/parse.ts, outside identity.ts.
```

Read-only, always: a review tool must never edit the code it is reviewing. Follow-ups resume
the conversation instead of resending the diff — 10,353 input tokens for the first question,
10 for the next.

## Generated code

Lockfiles, build output, anything marked `@generated`, workspace generator config, and
READMEs that are a heading and a tag table are collected into one trailing cohort. They are
out of the reading order, out of the progress count, and out of the model's token budget —
never hidden, always with the reason shown, and one click from coming back.

Nothing hand-written is touched. A README with a sentence, a usage example or even a TODO in
it is documentation and stays.

## Models

Through the `claude` CLI you are already signed in to. No API key.

| Pass | Model | Thinking |
|---|---|---|
| Per-file summaries | Haiku | off |
| Grouping and ordering | Sonnet | off |
| Ask | Sonnet | on |

Thinking is off where the task is to write one sentence: it costs seconds and buys nothing.
Summaries are skipped on changes over `changestack.ai.summariseUpTo` files (60), where each
call costs more and contributes less.

Your settings, your hooks and the reviewed repository's `CLAUDE.md` are kept out of every
call. A repository under review is data, not instructions.

`vscode-lm` is the alternative: your editor's own chat models, no subprocess, no PATH. It
cannot read the repository, so Ask answers from the diff alone and says so. Passes route
independently:

```jsonc
"changestack.passes": { "summaries": "vscode-lm", "clustering": "claude" }
```

Choosing a provider chooses where the code under review is sent, and the setting says so.

**With no model at all** — `changestack.ai.enabled: false`, or nothing installed — the review
still works, grouped by file, with marks, notes and navigation intact.

## Is the ordering any good?

`npm run eval` answers with a number rather than an opinion. It scores two things over pairs
of hunks against a hand-written expectation — **grouping** (do the two agree these belong
together) and **order** (are hunks in different cohorts read in the expected sequence) — and
prints both against the heuristic, which is what the model has to beat to be worth anything.

| | auth-clock | two-changes |
|---|---|---|
| grouping (model) | 100.0% | 100.0% |
| grouping (heuristic) | 80.0% | 60.9% |
| order (model) | 100.0% | 100.0% |
| order (heuristic) | 77.8% | 100.0% |

Two fixtures is thin evidence and each figure is one sample. The harness exists so the next
prompt change is measured rather than argued about — and it has earned that: keeping a
documentation hunk with the change it documents moved `two-changes` grouping from 87.0% to
91.3%.

## Development

```
npm install
npm run build      # bundle to dist/
npm run watch      # rebuild on change
npm run check      # typecheck
npm test           # unit tests
npm run eval       # score the grouping against the fixtures (spends tokens)
```

`F5` launches an Extension Development Host. `Change Stack: Doctor` reports git, `gh`,
`claude` and their sign-in state; `Change Stack: Show Log` has every model call with its
tokens, timing and cost.

[docs/DESIGN.md](docs/DESIGN.md) is how it is put together and why.
