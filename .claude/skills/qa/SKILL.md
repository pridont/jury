---
name: qa
description: QA a Jury pull request end to end. Checks the PR out into its own worktree, runs the gates, turns the PR's "Testing steps" into scripted scenarios in a real headless VS Code with a fake model, runs them, and reports pass/fail per step. Use when asked to "QA #8", "test PR 8", "do QA for pull request 8", or to verify a PR's feature works.
---

# QA a pull request

The input is a PR number (`#8`, `8`, or a PR URL). Do not edit product code during QA. The
only files you write are the scenario under `test/e2e/qa/` (gitignored) and the report.

## 1. Read the PR

```
gh pr view <n> --json number,title,body,url,headRefOid,files
```

Find the `## Testing steps` section in the body. If it is missing or vague, write your own
steps from the diff and the title, and say in the report that the PR had none.

## 2. Check it out in its own worktree

Work from the main checkout, not whatever worktree this session is in:

```
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
git -C "$ROOT" fetch origin pull/<n>/head
git -C "$ROOT" worktree add --detach "$ROOT/.claude/worktrees/qa-pr-<n>" FETCH_HEAD
```

If that worktree already exists, run `git -C "$ROOT/.claude/worktrees/qa-pr-<n>" checkout --detach FETCH_HEAD`
instead. `pull/<n>/head` works for forks and never clashes with a local branch. Then call
`EnterWorktree` with `path: "$ROOT/.claude/worktrees/qa-pr-<n>"` (expand `$ROOT` first) and
run everything below from there.

## 3. Gates

```
npm ci
npm run check
npm test
npm run test:e2e > /tmp/qa-pr-<n>-suite.log 2>&1; echo "exit=$?"
```

Record each result. A gate that fails is a finding. Carry on with step 4 anyway unless the
build itself is broken.

## 4. Turn each testing step into a scenario

Read `test/e2e/harness.ts` (the whole API, each helper documented) and
`test/e2e/review.test.ts` (worked examples). Read the source the PR changes, so you know the
real command IDs and what they do. Then write `test/e2e/qa/pr-<n>.test.ts`:

- One `suite('PR #<n>: <title>')`, and one `test('step <k>: <step name>')` per testing step.
- Each test starts from `fake.reset()` and `await repo.reset({...})` with the fixture the
  step's Setup describes, so it does not depend on the order the tests run in.
- **Do** maps to `vscode.commands.executeCommand('jury.…')`. Use `review()` for commands that
  open a review, and `void` plus `pick(i)` for commands that open a quick pick.
- **Expect** maps to assertions on what a reviewer would see: `sidebar()` text,
  `api.host.active` (files, cohorts, marks, comments, error), `api.nav.current`,
  `documentText()`, `vscode.window.activeTextEditor`, and `fake.calls()` for what was sent
  to the model.
- When a step depends on the model's answer, script it with `fake.reply(match, json)`.
  Without that, the fake gives a canned two-cohort grouping (`Fake cohort 1`, `Fake cohort 2`).
- Assert the specific outcome the step promises. `assert.ok(session)` proves nothing.

Mark a step **MANUAL** instead, with a one-line reason, when the harness cannot observe it:
how it looks (icons, colours, layout, themes), typing into a picker, the chat panel,
anything that talks to GitHub, real model quality, or native dialogs. Do not fake a pass.

## 5. Run

```
npx vite build --mode development
npx tsc -p tsconfig.e2e.json
npx vscode-test --run out/e2e/test/e2e/qa/pr-<n>.test.js > /tmp/qa-pr-<n>.log 2>&1; echo "exit=$?"
grep -E '✔|[0-9]+\) ' /tmp/qa-pr-<n>.log
sed -n '/passing/,$p' /tmp/qa-pr-<n>.log
```

VS Code's own log lines (EGL, ChatModelSelection, AgentHost, DeprecationWarning) are noise.

When a step fails, read the code before deciding. If the scenario misread the step (wrong
command, wrong fixture, an assertion that does not match the step's Expect), fix the scenario
and rerun, at most twice. If the product does not do what the step says, that is the finding.
Never weaken an assertion to make it pass.

## 6. Report

Reply with:

1. The PR title and the commit you tested (`headRefOid`, short form).
2. The gates: check, unit and e2e suite, each passed or failed. For a failure, give the
   first error line.
3. A table: step, PASS / FAIL / MANUAL, and the evidence. For a FAIL that is the assertion
   message plus the `file:line` of the code at fault, if you found it. For a MANUAL it is
   how to check it by hand.
4. Bugs found, one line each.

Do not post the report to GitHub unless the user asks. If they ask, use
`gh pr comment <n> --body-file <file>`.

At the end, call `ExitWorktree` with `action: "keep"`. Say where the worktree is. Remove it
with `git worktree remove .claude/worktrees/qa-pr-<n>` only when the user asks. If a
scenario is worth keeping as a regression test, suggest moving it to `test/e2e/` in the PR.
