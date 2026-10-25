<img src="media/jury-tile-128.png" alt="Jury" width="96">

# Jury

A VS Code extension that puts code in the order it should be read.

- **Reviewing a change.** Instead of showing files in alphabetical order, Jury groups the
  diff into related changes and orders them: new code first, then the code that uses it,
  then tests.
- **Understanding code.** Ask how something works, or ask for a tour of a repository or one
  folder of it. Jury opens the code to read, in order, with a note at each stop.

Either way, you step through it with `alt+j`, mark what you have read, and leave notes. A
language model finds and orders the code. You do the reading.

## Features

### Reviewing a change

- Groups a diff into **cohorts** (related work) and **layers** (steps within that work), in
  reading order.
- A short walkthrough of what the change does before you read any code. It also says where
  the pull request description or commit messages promise something the diff does not do,
  or leave out something it does.
- Review GitHub pull requests without checking them out, post your notes back as review
  comments, suggest changes the author can apply in one click, and reply to other reviewers.
- See how much code outside the change uses each function the change touches.
- Lockfiles and generated files are moved out of the way.
- Works without a model too, grouped by file.

### Understanding code

- Ask how something in the repository works, and get a **trail**: the code that answers it,
  in the order to read it.
- Ask for a **tour** of the whole repository or one folder: its parts in the order that makes
  each one understandable, with a diagram of how they fit together.
- Trails and tours are saved, so you can come back to one without asking again. A saved
  tour is also given to the model as a map of the codebase when it groups a later change.

### Both

- Press `alt+j` to go to the next hunk or span, opening the next file when needed, and
  `alt+k` to go back.
- Mark what you have read. Marks are saved and survive a rebase. Each row shows how much of
  it is done, and the status bar shows the total; click it to go to the next unread part.
- Leave notes on the code and export them as markdown.
- Ask questions about the code you are looking at.

## Requirements

- VS Code 1.90 or newer
- `git`
- The [`claude` CLI](https://claude.com/claude-code), signed in. Optional: without it, Jury
  groups by file and has no summaries or chat.
- The [`gh` CLI](https://cli.github.com), signed in. Only needed for pull requests.

## Quick setup

Jury is not on the VS Code Marketplace yet. To install it, build it from this repository.
You need [Node.js](https://nodejs.org) 20 or newer.

```
git clone https://github.com/pridont/jury.git
cd jury
npm install
npm run package
code --install-extension jury.vsix
```

If the `code` command is not found, install the `.vsix` from VS Code instead: open the
Extensions view, click the `...` menu at the top, choose **Install from VSIX…** and pick
`jury.vsix`.

Reload VS Code. Jury appears in the activity bar.

To update, pull the latest changes and run the last three commands again.

## Usage

Open the command palette and run one of:

| Command | Reviews |
|---|---|
| Jury: Review Working Tree | Uncommitted changes, including new files |
| Jury: Review Staged Changes | Staged changes |
| Jury: Review This Branch… | Everything the current branch adds, compared to a base branch you pick |
| Jury: Review a Pull Request… | A pull request you pick from a list |
| Jury: Review a Commit… | One commit, compared to its parent |
| Jury: Resume Last Review | The review you had open most recently |
| Jury: Walk Me Through… | Code that answers a question you type, in the order to read it |
| Jury: Tour This Repository… | How the repository, or one folder of it, is put together |
| Jury: Open a Saved Review… | A review you started earlier, picked from a list |

The review opens in the Jury panel in the activity bar.

While a review is open you can also run:

| Command | Does |
|---|---|
| Jury: Reorganise the Stack | Ask the model to group the change again |
| Jury: Stop Model Work | Cancel summaries or grouping that are still running |
| Jury: Next / Previous Unreviewed Hunk | Step through only the hunks you have not marked |
| Jury: Hide Reviewed / Show Reviewed | Hide fully reviewed cohorts and layers in the panel (also a button in its title bar) |
| Jury: Next / Previous Changed Hunk | Step through only the hunks the last refresh found new or changed |
| Jury: Mark Cohort Reviewed | Mark every hunk in a cohort |
| Jury: Open All Files in This Cohort / Step | Open the files together in one diff editor |
| Jury: Clear Model Answer Cache | Forget cached model answers, so the next run asks again |

### Keys

| Key | Action |
|---|---|
| `alt+j` / `alt+k` | Next / previous hunk |
| `alt+shift+j` / `alt+shift+k` | Next / previous layer |
| `alt+m` | Mark this hunk as reviewed |
| `alt+shift+m` | Mark this layer as reviewed and move to the next |
| `alt+a` | Ask about this hunk |
| `alt+s` | Open the walkthrough |

These only work while a review is open. **Ask About This Step** and **Focus Mode** have no
key by default, because the obvious ones are taken by VS Code (Toggle Block Comment, Toggle
Word Wrap). Focus mode only hides the sidebar, which `ctrl+b` already does. Bind either one
in Keyboard Shortcuts if you want a key for it.

### Marks

Marks are stored in `.git/jury/`, so they are not committed and survive restarting VS Code.

After the author pushes again, run **Jury: Refresh Review**. Hunks that are unchanged keep
their mark, even if they moved. Hunks whose content changed lose their mark, so you review
them again. Rows with new or changed hunks say **changed**, and **Next / Previous Changed
Hunk** steps through just those, until you open a different review.

### Uses outside the change

Above each function, method or class the change touches, a line says how many places use it
that are not part of the change, for example **3 uses outside this change · 2 files**. Click
it to see them. These are the callers the diff does not show you.

The count comes from the language server for that file, so it needs one (TypeScript works out
of the box). It reads the files in your working tree: for a pull request or branch you have
not checked out, it counts the callers in the code you have checked out.

### Notes

Hover a changed line and click **+** to leave a note. Notes stay attached to their code when
it moves. If the code is removed, the note is listed at the bottom of the panel so you can
move it or delete it.

Click **Resolve** on a note's thread once it is settled, and **Reopen** to undo it. A
resolved note is kept, and marked resolved in the export, but is not posted to GitHub.

To propose new code for a line, put the cursor on it in the new version of the file and run
**Jury: Suggest a Change to This Line** (also in the editor's right-click menu). It starts a
note holding the line as a GitHub suggested change; edit the line and save. On GitHub the
author can apply it with one click. If the code moves before you submit, the suggestion is
sent as a plain code block instead, so it cannot be applied to the wrong line.

**Jury: Export Review as Markdown** writes all notes out, grouped by cohort.

### Pull requests

Jury fetches the pull request into a separate ref and compares it to the base branch. Your
branch and working tree are not changed. Files you marked as viewed on GitHub start out
marked. It works the other way too: once every hunk of a file is marked, Jury ticks
**Viewed** for that file on GitHub, and unticks it if you unmark one again.

Comments other reviewers left on the pull request are shown on the diff, labelled **on
GitHub**. They are never exported. Comments on code that has changed since (outdated on
GitHub) are not shown. Run **Jury: Refresh Review** to fetch new ones.

To answer one, type in its thread and click **Reply on GitHub**. Jury asks before sending,
then posts the reply straight away, on its own rather than as part of your review, the same
as replying on GitHub. If it fails, you can copy the text you wrote.

**Jury: Submit Review to GitHub…** posts your notes as inline comments. It shows you exactly
what will be sent and asks before sending. Notes that were already posted are not posted
again.

Pick **Draft** to send the notes as a pending review instead. Only you can see it until you
finish and submit it on GitHub. Its notes count as posted, so if you delete the draft on
GitHub, edit a note to send it again.

### Asking questions

Type `@jury` in the Chat view, followed by your question. It answers about the hunk you are
on, the whole layer if you start with `/step`, or the whole cohort, every layer in it, if
you start with `/cohort`. A large cohort is sent up to a size limit; the hunks past it are
named but not shown, and it reads them from the repository when the question needs them.
It can read files in the repository to answer, but never changes them.

### Walking through code

**Jury: Walk Me Through…** asks a question about the repository, for example "How does a
review get saved?". You can also type `@jury /trail` and the question in the Chat view. The
model reads the repository and answers with a **trail**: the places in the code to read, in
the order to read them, with a line on each saying why it is there.

The trail opens in the Jury panel like a review. Each stop is a row, each range of code is a
span you step through with `alt+j` and mark with `alt+m`, and you can leave notes on it. The
walkthrough shows the short answer. The files open as they are in your working tree, not as a
diff. A trail is saved like any review: **Jury: Open a Saved Review…** brings it back without
asking the model again. It needs a provider that can read the repository (`claude`).

### Touring a repository

**Jury: Tour This Repository…** is a trail for someone new to the code. Pick the whole
repository or one folder. The model explores it and lays out a tour: the areas of the code
(for example "Git layer" or "Editor UI"), in the order that makes each one understandable,
with a few stops in each. Every area is a row in the Jury panel and its stops are below it.
The walkthrough shows a summary and a diagram of how the areas fit together.

Jury then asks how thorough the tour should be:

| Choice | Model | On this repository |
|---|---|---|
| **Detailed** (default) | the `deep` model, Opus | 27–29 stops, about 2 minutes, about $1.20 |
| **Quick** | the `smart` model, Sonnet | 20–24 stops, about 45 seconds, about $0.30 |

A detailed tour covers more of the code and says more at each stop about how things work.
A tour is saved, so you pay for it once. Touring one folder costs less.

A saved tour also helps later reviews. When a change is grouped, the model is given the tour
that covers most of the changed files as a map of the codebase, so cohort summaries can say
which part of the code a change touches, for example "the Gateway's authenticate middleware".
Take a new tour when the code has changed a lot; the old one is still used until then.

### Generated files

Lockfiles, build output, files marked `@generated`, Nx project config, and empty template
READMEs are collected into a **Scaffolding** group at the end. They are skipped when
stepping through the review and not counted in progress. Each shows why it was moved, and
you can bring any of them back with **Not Scaffolding**.

## Models

Jury uses the `claude` CLI, so there is no API key to set up.

| Task | Model |
|---|---|
| Summarising each file | Haiku |
| Grouping and ordering | Sonnet |
| Answering questions | Sonnet |

File summaries are skipped for changes larger than 60 files.

Jury does not load your Claude settings, hooks or `CLAUDE.md` files, including the ones in
the repository being reviewed.

You can also use the chat models built into VS Code (for example Copilot) by setting the
provider to `vscode-lm`. These cannot read the repository, so answers are based on the diff
only.

## Settings

| Setting | Default | Description |
|---|---|---|
| `jury.ai.enabled` | `true` | Use a model at all |
| `jury.provider` | `claude` | `claude` or `vscode-lm` |
| `jury.providers` | | Command and models per provider |
| `jury.passes` | `{}` | Use a different provider for summaries, grouping or questions |
| `jury.ai.summariseUpTo` | `60` | Skip file summaries above this many files. `0` turns them off |
| `jury.scaffolding.mode` | `collapse` | `collapse`, `inline` or `off` |
| `jury.scaffolding.patterns` | `[]` | Extra paths to treat as generated. Start with `!` to exclude one |
| `jury.walkthrough.autoOpen` | `true` | Open the walkthrough when grouping finishes |

## Development

```
npm install
npm run build     # build to dist/
npm run watch     # rebuild on change
npm run check     # typecheck
npm test          # unit tests
npm run eval      # measure grouping quality (calls the model)
```

Press `F5` to run the extension in a new window. **Jury: Doctor** checks that `git`, `gh`
and `claude` are available. **Jury: Show Log** lists every model call with its token count
and cost.

`npm run eval` compares the model's grouping to hand-written expectations and to a simple
file-based grouping:

| | auth-clock | two-changes |
|---|---|---|
| Grouping, model | 100% | 100% |
| Grouping, by file | 80% | 61% |
| Order, model | 100% | 100% |
| Order, by file | 78% | 100% |

See [docs/DESIGN.md](docs/DESIGN.md) for how it works.

## License

MIT
