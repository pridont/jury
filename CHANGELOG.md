# Changelog

## Unreleased

### Unreleased
- Picking what to review is a list now, not a blank box. `Review This Branch…` offers the
  repository's trunk first, then every branch, remote branch and tag ordered by how recently
  it moved, then recent commits — each with its date and subject line, because "8 weeks ago"
  and "feat: blog and news" are what answer "is this the one I mean". The branch you are
  standing on is left out: it is never the answer to what that branch added.
- `Review a Pull Request…` lists the open pull requests, the one for your current branch
  first, with author, draft state and head branch.
- Both still accept anything typed — a tag you remember the name of, a SHA, a number — as
  the first entry in the list rather than by abandoning it for another command.

### V8 — pull requests
- `Review a Pull Request…` — by number, or empty for the one on this branch. The head is
  fetched into `refs/changestack/pr-<n>` and compared against the **merge base** of its
  target branch: what the author asked to have merged, not a comparison with whatever that
  branch has done since. Nothing is checked out and the working tree is not touched.
- Both sides of the diff are read-only blobs served from git.
- GitHub's "viewed" state is read on open, so a review carries on where it was left on the
  web rather than starting from nothing.
- `Submit Review to GitHub…` posts the notes as inline comments, as Comment, Approve or
  Request changes. Positions use `line` + `side` rather than the diff-`position` arithmetic
  GitHub's older API wanted, which is wrong the moment the diff differs from what it was
  computed against.
- The whole payload is shown first — every comment, every position, and everything that will
  *not* be sent — and then confirmed in a modal. Posting to someone else's repository is not
  something to do on a keystroke.
- A note whose position is a guess is still sent, and says so in its own text. A note whose
  code is gone is not sent, and is listed rather than dropped silently. Notes on binary
  changes are reported as unplaceable instead of failing the whole submission.
- The payload goes as one JSON body on stdin: comment bodies are arbitrary text, and
  argument-shaped building is how a comment containing a quote becomes a malformed request.

### V7 — ask, and the second provider
- `@changestack` in the chat view answers questions about the change under the cursor, or
  about the whole step with `/step`. Streaming, follow-ups, markdown, code links and
  cancellation are the chat view's, not ours.
- Tool calls are surfaced as they happen — `Grep isExpired` — so a pause has a visible reason
  and the answer's basis is legible. The tool set is read-only: a review tool must never edit
  the code it is reviewing.
- A follow-up resumes rather than restates. Measured on a real question: 10,353 input tokens
  for the first, 10 for the follow-up.
- **`vscode-lm`**: the user's Copilot subscription, or whatever chat models their editor has.
  No subprocess, no PATH, no API key. It exists to test whether the provider interface fits
  anything but the adapter it was written against, and it found two things. That API has no
  conversation handle, so `Answer.session` is absent and a follow-up resends its context —
  which callers already tolerate because the field is optional. And it cannot yet read the
  repository, so it declares `repoTools: false`, Ask answers from the diff alone, and says
  so in the answer rather than quietly being worse than the other provider.
- Passes route independently: summaries are many small calls and the cheapest to send
  elsewhere; clustering is the one call that decides the reading order.

### Unreleased fixes
- The walkthrough was the tree written out as prose — the same information in a worse medium,
  spent on the one moment a reviewer will read prose. It now answers what the tree cannot:
  what the software does now that it did not, and why the reading order is what it is. No
  file lists, no layer outlines.
- The model may return a mermaid diagram, and is told that omitting it is the normal answer:
  a picture earns its place only when the change has a shape prose does not show — a request
  crossing components, a state machine, a data model. A `diagram` field that is not actually
  a diagram is dropped, because prose there renders as a broken block rather than as nothing.
  When no mermaid renderer is installed, the walkthrough says so and links to one.
- Clicking a step that spans files opened one of them, and next-hunk would not cross to the
  rest: reveal used `activeTextEditor`, which after `vscode.diff` is not reliably the editor
  just opened. A step now opens whole and expands to its files in the tree.
- Navigation selected the step rather than the file being read, and tree items had no stable
  ids — so reveal was unreliable and expansion state reset on every refresh, which happens
  once per summary as pass 1 lands.
- Risk icons were VS Code's diagnostics vocabulary. A red error cross says *this code is
  broken*; risk means *read this carefully*, which is a different claim.
- Dimming in the diff meant both "did not change" and "belongs to another step". It now means
  only the first; the step being read is marked with a border.
- Both model passes now say what they are doing while they do it.

### V6 — clustering
- Pass 2: the change set grouped into cohorts by intent and put in dependency-first reading
  order — introduce a thing, then the code that uses it, then the plumbing, then the tests.
  This is the reorganisation the extension exists for.
- The stack reorganises **exactly once**, with an announcement, and the hunk being read stays
  selected across the change. A view that rearranges itself under the reader is worse than
  one that never improves.
- `merge.ts` disposes of what the model proposes. Invented labels are dropped, repeats keep
  their first home, empty layers and cohorts go, whatever went unplaced lands in a trailing
  "Unclassified" cohort, and generated and docs cohorts move to the end regardless of what
  was asked for. Any output, however malformed, either yields a complete partition of the
  hunk set or is declined outright.
- Declined: everything in one cohort, one cohort per file, or most of the diff left unplaced.
  A wrong answer that looks like an answer is worse than no answer, so the heuristic stack
  stays and nothing is written to the cache. A cached clustering is judged again on the way
  out, so an entry stored before a caller learned to reject it is asked again.
- The digest sheds detail — samples shrink, then go — but never structure. A hunk the model
  never sees is a hunk it cannot place. Labels are `h1`, `h2`: short to write back, and an
  invented one is obviously invalid rather than plausibly real. Any that leak into prose are
  replaced by the file they stand for before a reader sees them.
- The walkthrough: what the change set is, before any code.
- `npm run eval` scores grouping and order over pairs of hunks against a hand-written
  expectation, next to the heuristic baseline. A fixture can mark two cohorts as unordered
  when their relative order is a coin flip, so the order figure measures dependencies rather
  than arbitrary choices. Answers are cached, so re-running an unchanged prompt is free and
  editing one invalidates exactly the answers it affects.

### V5 — provider layer, Claude, per-file summaries
- A `Provider` interface with declared capabilities, and the Claude CLI as its first
  implementation. Prompts are prose and a JSON shape with no provider dialect in them, and
  tools are named by capability rather than by product, so a second adapter is a new file
  and not a rewrite.
- Claude runs through the CLI you are already signed in to — no API key. `--setting-sources ""`
  keeps your settings, your hooks and the reviewed repository's `CLAUDE.md` out of every
  call: a repository under review is not a source of instructions this extension obeys.
- Pass 1: one or two sentences per file, in parallel, appearing as each lands. Not awaited —
  the review is on screen and navigable before a single request is sent.
- Answers are cached on disk under `.git/`, keyed by prompt version, model and input, so
  reopening a review costs nothing and starts no subprocess. An answer is only cached once
  the caller has accepted it: a schema-valid non-answer cached is a known-bad result replayed
  on every open.
- One repair retry quoting the parse error, then the heuristic description stands. Model
  output is fence-stripped first, because models fence JSON even when told not to.
- Closing or refreshing a review cancels every request it started, queued or running.
- Scaffolding is never summarised. `Doctor` reports each provider's models and capabilities;
  an unavailable one is announced once per window, not once per review.

### V4 — comments and export
- Review notes as native comment threads on the diff. The gutter only invites a note where
  there is a hunk: a note left on unchanged context is one nobody finds again.
- Anchored to `{hunkId, offset, side}` and never to a file line, so a note holds its place
  when code above it moves. Persisted with the rest of the review state.
- Comments take the fuzzy matches marks refuse. Losing a note is worse than showing it a
  couple of lines off, so a moved note follows its code and is labelled "position is
  approximate". A note whose code is gone is listed under **Notes whose code is gone**, to
  re-pin or discard — never silently dropped.
- Clearing a note's text deletes it; an empty comment is not a comment.
- `Export Review as Markdown` — grouped by cohort rather than by path, because the grouping
  is the review. Every note carries a `file:line`, generated files are not counted as work
  the reviewer skipped, and a guessed position says so.

### V3 — state, marks, refresh, anchoring
- Review progress persists under `<git-common-dir>/changestack/`, written atomically so a
  crash mid-write leaves the previous state intact rather than a truncated one. Inside
  `.git`, so it is never committed and never dirties the working tree, and shared by every
  worktree of the repository.
- A review is keyed by what was asked for, never by the revisions that resolved to: a review
  of `main...HEAD` survives main moving on, instead of silently starting over on every push.
- `Resume Last Review` and `Open a Saved Review…`.
- Refresh re-diffs and re-anchors. A mark is carried only by an exact content match — a hunk
  that changed comes back unreviewed however similar it looks, because a tick that survives
  an edit is a lie. Refresh says what it did: `refreshed · 5 marks kept · 2 changed · 1 gone`.
- Fuzzy anchoring for what is not exact: same file, added lines compared only with added
  lines, identical lines matched first and the remainder paired by how much of each line
  survived. Below the threshold a hunk is orphaned rather than guessed at, and no two hunks
  can claim the same replacement. Marks refuse a fuzzy match; comments will accept one and
  carry the flag.
- A save that fails says so, rather than letting the reviewer believe a tick was recorded.

### V2 — the review UI, no AI
- Heuristic cohorts: the always-available baseline. Groups by file, pairs a test with the
  source it tests — including across mirrored trees, when the basename is unambiguous — and
  orders code before config before tests before docs. Cohorts it invents are `change`, never
  `fix` or `refactor`: intent is not something a path can reveal.
- Scaffolding detection. `.gitattributes` (`linguist-generated`, `-diff`), in-file generated
  markers, lockfiles and vendored trees, and workspace project config in a repository that
  actually has generators. A root registry such as `nx.json` is only claimed when the edit is
  small, net additive, and sits beside output already recognised as generated.
  Scaffolding is collected into one trailing cohort, skipped by navigation, and left out of
  the progress count — never hidden, never auto-marked reviewed, always with its reason
  shown, and one click from coming back.
- Read-only `changestack:` documents served straight from `git show`; no temp files, no
  checkout. A worktree review keeps the real file on the new side so a language server is
  attached and a typo can be fixed in place.
- Reading order flattened across cohorts, layers and files, so one key walks the whole
  review and file boundaries stop being something to think about. Stops at the ends rather
  than wrapping.
- Out-of-layer dimming, cursor-to-hunk sync, tree checkboxes for reviewed state, and a
  progress badge counting only what a person is expected to read.
- `alt+j`/`alt+k` hunks, `alt+shift+j`/`alt+shift+k` layers, `alt+m`/`alt+shift+m` reviewed,
  `alt+z` focus mode — all gated behind an open review.

### V1 — git and diff core
- Diff acquisition for the working tree, the index, and a branch range (three-dot against
  the merge base, so a moving base branch does not change what the review shows).
- Unified diff parser: renames, copies, mode changes, binary files, additions, deletions,
  `\ No newline at end of file`, CRLF, paths containing spaces, and empty repositories.
- Content-based hunk identity — a mark survives a rebase that moves the code and resets when
  the hunk itself changes. Identical hunks in one file stay independently reviewable.
- Untracked files are synthesised as added-file diffs, so a brand new file is visible;
  binary or over 512 KB is listed rather than shown.
- Every change git can report yields at least one hunk, synthetic when it has no text.
- Enclosing-symbol labels from the document symbol provider, degrading to git's own heading.
- The stack view lists the parsed diff and says when acquisition failed, rather than looking
  like "no changes".

### V0 — scaffold
- Extension skeleton, view container and stack tree view.
- `Review Working Tree`, `Review Staged Changes`, `Review This Branch…`, `Close Review`.
- `Change Stack: Doctor` — git, repository, `gh` sign-in, `claude` availability.
- Repository resolution that shares state across linked worktrees.
- Unit test harness (vitest) and esbuild bundling.
