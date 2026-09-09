# Changelog

## Unreleased

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
