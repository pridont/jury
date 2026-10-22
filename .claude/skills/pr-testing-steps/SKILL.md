---
name: pr-testing-steps
description: Write a "Testing steps" section into every Jury pull request description that adds or changes behaviour, in the format the qa skill turns into scripted VS Code scenarios. Use whenever creating a PR (gh pr create), writing or editing a PR description, or when asked for testing steps for a change.
---

# Testing steps in PR descriptions

Every PR that adds or changes behaviour gets a `## Testing steps` section in its
description. The `qa` skill reads this section and scripts each step against a real VS Code
window, so write steps a script can follow. A person should be able to follow them too.

## Format

```markdown
## Testing steps

1. **<what this step proves, in a few words>**
   - Setup: <repository state: files and their contents, commits, staged changes, settings>
   - Do: <the command ID, e.g. `jury.review`, or the exact UI action>
   - Expect: <what the reviewer can observe afterwards>

2. …

### Manual only

- <a check a script cannot make>: <how to check it by hand>
```

## Rules

- Cover the happy path, every edge case the PR handles on purpose, and one check that the
  nearest existing behaviour still works.
- **Setup** is concrete: name the files and say what changes in them. Write "`src/a.ts`
  modified in 2 places, `package-lock.json` modified", not "a repo with some changes".
  Say which settings differ from the defaults (`jury.ai.enabled: false`). When the step
  depends on what the model answers, say what answer to assume.
- **Do** uses the command IDs from `package.json` (`jury.nextHunk`, `jury.markLayerReviewed`).
  For a quick pick, say which item to choose. Name a tree row by its visible label.
- **Expect** names something observable: sidebar rows and their text or ticks, which file
  opens and at which line, the text of an exported or opened document, a notification's
  text, a saved state, or that no model call was made. Never "verify it works".
- Put a check under **Manual only** when a script cannot observe it. That covers how
  something looks (icons, colours, layout, themes), typing into a picker, the chat panel,
  posting to GitHub, and the quality of a real model answer.
- When the PR adds e2e tests under `test/e2e/`, list which steps they already cover.
- A PR with no behaviour change (refactor, chore, docs) gets one line instead:
  `No behaviour change: covered by npm test and npm run test:e2e.`

## Example

```markdown
## Testing steps

1. **Lockfiles collapse into the scaffolding cohort**
   - Setup: commit `src/a.ts` and `package-lock.json`, then modify both.
   - Do: `jury.review`
   - Expect: the last sidebar row is `Scaffolding · 1 file` and contains `package-lock.json`.
     No other cohort lists it.

2. **`inline` mode keeps them in the reading order**
   - Setup: as in step 1, with `jury.scaffolding.mode: "inline"`.
   - Do: `jury.review`
   - Expect: no `Scaffolding` row. `package-lock.json` appears in a normal cohort.

### Manual only

- The scaffolding row's icon is greyed out: open the Jury view and look at the row.
```
