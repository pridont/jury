---
name: qa
description: QA a Jury pull request end to end. Checks the PR out into its own worktree, runs the gates, turns the PR's "Testing steps" into e2e tests under test/e2e/ that run in a real headless VS Code with a fake model, commits them to the PR as regression tests, and reports pass/fail per step. Use when asked to "QA #8", "test PR 8", "do QA for pull request 8", or to verify a PR's feature works.
---

# QA a pull request

The input is a PR number (`#8`, `8`, or a PR URL). QA always ends with e2e tests committed to
the PR: every step a script can check becomes a test under `test/e2e/` that stays in the suite
as a regression test. Do not edit product code during QA. The only files you write are those
tests and the report.

## 1. Read the PR

```
gh pr view <n> --json number,title,body,url,headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,files
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

## 4. Turn each testing step into an e2e test

Read `test/e2e/harness.ts` (the whole API, each helper documented) and the existing
`test/e2e/*.test.ts` (worked examples). Read the source the PR changes, so you know the real
command IDs and what they do.

First check which steps the PR's own tests under `test/e2e/` already cover. A step is covered
only when a test asserts that step's Expect. Do not duplicate it; note which test covers it.

For the rest, write tests that read as part of the permanent suite, not as a QA script:

- Put each test in the `test/e2e/` file for the area it exercises (`review.test.ts`,
  `navigation.test.ts`, …), inside that file's suite. When no file fits, create
  `test/e2e/<area>.test.ts` with one `suite('<area>')`. No PR numbers in file, suite or test
  names.
- Name each test after the behaviour it proves, in the style of the existing tests:
  `test('lockfiles collapse into the scaffolding cohort', …)`, not `test('step 1', …)`.
- Each test starts from `fake.reset()` and `await repo.reset({...})` with the fixture the
  step's Setup describes, so it does not depend on the order the tests run in. Reuse the
  file's `setup` and fixtures when they already match. Undo any setting you change in a
  `teardown` or `suiteTeardown`, or later suites inherit it.
- **Do** maps to `vscode.commands.executeCommand('jury.…')`. Use `review()` for commands that
  open a review, `void` plus `pick(i)` for the review pickers, and `row(/label/).node` for
  commands run from a sidebar row's context menu. Answer messages, input boxes, `showQuickPick`
  lists and save dialogs ahead of time with `dialogs.answer`, `type`, `choose` and `saveTo`;
  anything unanswered is dismissed. Change settings with `configure({...})` and call the undo
  it returns.
- **Expect** maps to assertions on what a reviewer would see: `sidebar()` text,
  `api.host.active` (files, cohorts, marks, comments, error), `api.nav.current`,
  `documentText()`, `vscode.window.activeTextEditor`, `dialogs.messages()` for notifications,
  `fake.calls()` for what was sent to the model and `gh.calls()` for what was sent to GitHub.
- When a step depends on the model's answer, script it with `fake.reply(match, json)`.
  Without that, the fake gives a canned two-cohort grouping (`Fake cohort 1`, `Fake cohort 2`).
  A step on a pull request scripts `gh.reply(match, stdout)`; `test/e2e/pull-request.test.ts`
  shows how to stand up a pull request against a local `origin`.
- Assert the specific outcome the step promises. `assert.ok(session)` proves nothing.
- When the harness lacks a helper a step needs, write the step as best the existing API
  allows, or mark it MANUAL. Do not grow the harness during QA; say in the report what helper
  would have made the step testable.

Mark a step **MANUAL** instead, with a one-line reason, when the harness cannot observe it:
how it looks (icons, colours, decorations, status bar text, layout, themes), typing into a
`pickOrType` picker, ticking a sidebar checkbox, the chat panel, reloading the window, the
real GitHub, or real model quality. Do not fake a pass.

## 5. Run

Run each file you touched first, then the whole suite, so you know the new tests pass alone
and do not break or depend on the others:

```
npx vite build --mode development
npx tsc -p tsconfig.e2e.json
npx vscode-test --run out/e2e/test/e2e/<area>.test.js > /tmp/qa-pr-<n>.log 2>&1; echo "exit=$?"
grep -E '✔|[0-9]+\) ' /tmp/qa-pr-<n>.log
sed -n '/passing/,$p' /tmp/qa-pr-<n>.log
npx vscode-test > /tmp/qa-pr-<n>-suite.log 2>&1; echo "exit=$?"
```

VS Code's own log lines (EGL, ChatModelSelection, AgentHost, DeprecationWarning) are noise.

When a test fails, read the code before deciding. If the test misread the step (wrong
command, wrong fixture, an assertion that does not match the step's Expect), fix the test
and rerun, at most twice. If the product does not do what the step says, that is the finding:
keep the test as it is, failing. It is the bug's reproduction, and it goes green when the
author fixes the bug. Never weaken an assertion to make it pass, and never skip it.

## 6. Commit

Commit the tests on top of the PR head, in the QA worktree:

```
npm run check
git add test/e2e
git commit -m "test(e2e): cover <what the PR adds>"
```

Pushing changes the author's PR, so push only when the user asked for it in this request.
Push to the PR's branch, not to `main`:

- Same repository (`isCrossRepository: false`):
  `git push origin HEAD:refs/heads/<headRefName>`
- Fork with `maintainerCanModify: true`:
  `git push https://github.com/<headRepositoryOwner.login>/<headRepository.name>.git HEAD:refs/heads/<headRefName>`
- Fork without it: do not push. Give the commit and the test files so the author can take them.

If the push is rejected because the branch moved, fetch it, rebase the commit onto it, rerun
the touched files, and push again. Never force-push.

## 7. Report

Reply with:

1. The PR title and the commit you tested (`headRefOid`, short form).
2. The gates: check, unit and e2e suite, each passed or failed. For a failure, give the
   first error line.
3. A table: step, PASS / FAIL / MANUAL, the test that covers it (`file` and test name), and
   the evidence. For a FAIL that is the assertion message plus the `file:line` of the code at
   fault, if you found it. For a MANUAL it is how to check it by hand.
4. Bugs found, one line each.
5. The test commit (short SHA) and whether it was pushed. If not, the push command from
   step 6.

Do not post the report to GitHub unless the user asks. If they ask, use
`gh pr comment <n> --body-file <file>`.

At the end, call `ExitWorktree` with `action: "keep"`. Say where the worktree is. Remove it
with `git worktree remove .claude/worktrees/qa-pr-<n>` only when the user asks, and only once
the test commit is pushed or handed over.
