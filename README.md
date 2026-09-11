<img src="media/jury-tile-128.png" alt="Jury" width="96">

# Jury

A VS Code extension for reviewing code changes. Instead of showing files in alphabetical
order, Jury groups the diff into related changes and puts them in the order they should be
read. A language model does the grouping. You do the reviewing.

## Features

- Groups a diff into **cohorts** (related work) and **layers** (steps within that work), in
  reading order: new code first, then the code that uses it, then tests.
- A short walkthrough of what the change does before you read any code.
- Step through every hunk with one key, across files.
- Mark hunks as reviewed. Marks are saved and survive a rebase.
- Leave notes on the diff and export them as markdown.
- Review GitHub pull requests without checking them out, and post your notes back as review
  comments.
- Ask questions about the code you are looking at.
- Lockfiles and generated files are moved out of the way.
- Works without a model too, grouped by file.

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

The review opens in the Jury panel in the activity bar.

### Keys

| Key | Action |
|---|---|
| `alt+j` / `alt+k` | Next / previous hunk |
| `alt+shift+j` / `alt+shift+k` | Next / previous layer |
| `alt+m` | Mark this hunk as reviewed |
| `alt+shift+m` | Mark this layer as reviewed and move to the next |
| `alt+a` | Ask about this hunk |
| `alt+shift+a` | Ask about this layer |
| `alt+s` | Open the walkthrough |
| `alt+z` | Focus mode |

These only work while a review is open.

### Marks

Marks are stored in `.git/jury/`, so they are not committed and survive restarting VS Code.

After the author pushes again, run **Jury: Refresh Review**. Hunks that are unchanged keep
their mark, even if they moved. Hunks whose content changed lose their mark, so you review
them again.

### Notes

Hover a changed line and click **+** to leave a note. Notes stay attached to their code when
it moves. If the code is removed, the note is listed at the bottom of the panel so you can
move it or delete it.

**Jury: Export Review as Markdown** writes all notes out, grouped by cohort.

### Pull requests

Jury fetches the pull request into a separate ref and compares it to the base branch. Your
branch and working tree are not changed. Files you marked as viewed on GitHub start out
marked.

**Jury: Submit Review to GitHub…** posts your notes as inline comments. It shows you exactly
what will be sent and asks before sending. Notes that were already posted are not posted
again.

### Asking questions

Type `@jury` in the Chat view, followed by your question. It answers about the hunk you are
on, or the whole layer if you start with `/step`. It can read files in the repository to
answer, but never changes them.

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
