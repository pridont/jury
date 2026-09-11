# Design

How Jury works, and why some parts are built the way they are.

## Concepts

- **Hunk:** one contiguous block of a diff. The smallest unit you can mark as reviewed.
- **Layer:** a set of hunks that make up one step of the reading. A layer can span files.
- **Cohort:** a group of related layers. The tree lists cohorts.
- **Scaffolding:** hunks recognised as generated files. They are shown, but kept out of the
  reading order and out of what is sent to the model.

The order of cohorts and layers is simply the order they are listed in. The model decides
that order when it groups the change, so there is no separate dependency graph to maintain.

## How a review is built

```
git diff → parse → detect generated files → group by file → shown in the tree
                                                  │
                                                  ├─ pass 1: one sentence per file   (Haiku)
                                                  └─ pass 2: group and order         (Sonnet)
                                                                   │
                                                          checked, then replaces the tree once
```

The file-based grouping appears first and is usable straight away. The model passes run in
the background. File summaries are skipped for changes over 60 files.

## Hunk identity

A hunk's id is a hash of its file path and its added and removed lines. Context lines and the
`@@` header are left out. This means a hunk keeps its id when code above it moves, and gets a
new id when its own lines change.

Two identical hunks in the same file get a number added to the id so they stay separate. A
file with no text changes (a binary file, a rename, a permission change, an empty new file)
gets one placeholder hunk so it can still be listed and marked.

## Marks and notes after a refresh

When you refresh, each old hunk is matched to the new diff as one of:

- **exact:** the same id is still there
- **moved:** same file, at least 80% similar
- **gone:** no match

Marks and notes treat a "moved" match differently:

- A **mark** is only kept on an exact match. If a hunk changed at all, you should look at it
  again.
- A **note** follows a moved match and is labelled "position is approximate". Showing a note
  slightly out of place is better than losing it.

Similarity compares added lines with added lines and removed lines with removed lines. If they
were mixed, a change and its exact reversal would look identical. Identical lines are matched
first, then the rest are paired by how much of each line is the same.

## Checking the model's grouping

The model's answer is only used if every hunk ends up in exactly one place. Before that,
Jury cleans it up:

- ids the model made up are dropped
- a hunk listed twice keeps its first position
- empty layers and cohorts are removed
- hunks the model left out go into an **Unclassified** cohort at the end
- documentation and generated cohorts are moved to the end

The answer is rejected, and the file-based grouping kept, if everything is in one cohort, if
there is one cohort per file, or if most hunks were left out. Rejected answers are not cached.

In the text sent to the model, hunks are labelled `h1`, `h2` and so on. Short labels are
cheap to repeat back, and a made-up one is easy to spot. If a label shows up in a title or
summary, it is replaced with the file name before you see it.

## What the model sees

For each hunk: its label, file, the function it is in, how many lines were added and
removed, and a few of the changed lines. The per-file summaries from pass 1 are included
too. On large changes the sample lines are shortened and then dropped, but every hunk is
always listed, because the model cannot place a hunk it was never shown.

## Detecting generated files

Checked in this order, most certain first:

1. `.gitattributes` marks the file `linguist-generated` or `-diff`.
2. The file says it was generated (`@generated`, "was generated with").
3. Lockfiles, vendored folders and build output.
4. Project config such as `project.json`, in a repository that uses generators (Nx,
   Angular, Turborepo).
5. A new folder that arrives with two or more generator-style config files and at least three
   files in total. Only the config files are moved; the code in the folder is not.
6. A new file of 200 lines or more that is very repetitive or has a line over 2,000
   characters.
7. A new markdown file with only headings and metadata in it.

Each file shows why it was moved and can be brought back with **Not Scaffolding**. Jury
remembers that choice for the repository. The rules lean towards leaving a file in the
review, because hiding real code is worse than showing a generated file.

## Providers

Model access sits behind one interface with two implementations: `claude` and `vscode-lm`.
Prompts contain plain instructions and a JSON format, nothing specific to one model. Tools are
requested by what they do (`readFile`, `search`), and each provider maps those to its own
tools. A provider without repository tools says so, and Ask answers from the diff only.

`vscode-lm` has no way to continue a conversation, so its follow-up questions resend the
context. It also cannot read files.

The queue, cache, JSON repair and cancellation are shared by both providers.

## Calling Claude

Jury runs the `claude` CLI. Every call uses `--setting-sources ""` so that your settings,
your hooks and the `CLAUDE.md` of the repository being reviewed are not loaded. The reviewed
code should never be able to change how the model behaves. `--system-prompt` replaces the
CLI's default instructions, and `--tools ""` turns off tools for summaries and grouping.

Answers are cached in `.git/`, by prompt version, model and input. Changing a prompt means
only the answers from that prompt are asked for again. An answer is cached only after it has
been checked.

If the model returns broken JSON, Jury first fixes the common problems itself (a raw newline
in a string, a trailing comma). If that is not enough, it sends the broken answer back and
asks for a corrected one.

Every process Jury starts is tracked. Closing a review stops what it started, and a guard
catches VS Code shutting down without cleaning up, so no model call keeps running after you
close the editor.

## Where state is kept

Review progress is saved in `.git/jury/<reviewId>.json`. It is not committed, does not
show up as a change, and is shared by all worktrees of the repository. It is written to a
temporary file first and then renamed, so a crash cannot leave a half-written file.

A review is identified by what you asked to review (for example `main...HEAD`), not by commit
hashes. That way your progress survives `main` moving forward.

State saved under the extension's old name (`.git/changestack/`) is moved over the first
time you open a review in that repository.

## Loading icons

While work is running, the first row of the tree shows what is happening, with an animated
icon for the kind of work:

| Icon                    | When                             |
| ----------------------- | -------------------------------- |
| `jury-scanning.svg`     | Reading the diff                 |
| `jury-answering.svg`    | File summaries are coming in     |
| `jury-deliberating.svg` | The model is grouping the change |

Each animation stops after about 8 seconds and settles into the static mark. With reduced
motion turned on, the static mark is shown from the start. Both rules are written into the SVG
files themselves.

The tree draws icons as images, so the icons cannot take the theme's text colour. Jury writes
a light and a dark copy of each loader into its storage folder when it starts, and the tree
uses the one that matches the theme.

## Code layout

```
src/
  git/        finding the repository, getting the diff, parsing it, hunk ids
  model/      types, generated-file detection, grouping, merging, reading order
  agent/      provider interface, providers, queue, cache, JSON repair, prompts
  state/      saving progress, matching hunks after a refresh
  ui/         tree, diff editor, navigation, notes, chat, walkthrough, loading icons
  github/     pull requests and posting reviews
media/        icons
test/
  unit/       unit tests, with diffs generated from real git
  eval/       grouping quality against hand-written expectations
```

Everything is bundled into `dist/extension.js` with esbuild. There are no runtime
dependencies, which is why packaging uses `vsce package --no-dependencies`.

## Not planned

- **Reviewing commit by commit.** It would need a different interface.
- **Editing code.** Jury only reads. Ask's tools can read files but never change them.
- **A custom webview.** VS Code's own diff editor, comments and chat already do the job,
  and they come with language support.
