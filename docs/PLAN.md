# Change Stack for VS Code — implementation plan

## Context

Reviewing a non-trivial diff in an editor today means reading files in alphabetical order:
almost never the order that makes the change comprehensible. You read the caller before the
callee and the test before the thing it tests, you rebuild the "what is this change actually
doing" model on every file switch, and you lose your place when the author pushes again.

CodeRabbit's [Change Stack](https://docs.coderabbit.ai/pr-reviews/change-stack) answers this
on the web: it reorganises a pull request from a flat file list into **cohorts** of related
work, each broken into **layers** that establish a reading order where foundational changes
come before the code that depends on them. Every layer anchors to specific line ranges, and
carries its own AI-written summary. It is a good idea trapped in a browser tab, away from
LSP, go-to-definition, and the rest of the repository.

This plan builds that idea as a VS Code extension, driven by a subscription the reviewer
already pays for rather than a hosted service. v1 speaks to Claude through the `claude` CLI;
everything model-specific sits behind one small provider interface (§6) so a Copilot, Codex,
Gemini or local-model user can point it at what they have. It is an independent design — not
a port of anything — and it reviews both local work (worktree, index, branch) and GitHub pull
requests, with review comments posted back.

**Intended outcome:** open a diff, get a walkthrough and an ordered stack of cohorts within
a couple of seconds, walk every hunk in reading order with the keyboard without ever
thinking about files, leave comments, and submit them — all inside the editor, with the AI
assisting and never blocking.

Confirmed environment: VS Code 1.135.0, Node 24, `gh` 2.92.0, `claude` 2.1.235 (all CLI
flags this plan relies on verified present).

---

## 1. The concept

- **Hunk** — a contiguous diff block. The atom; the unit that gets marked reviewed.
- **Layer** — an ordered set of hunks forming one step of the reading. Carries a title, a
  summary, and its anchored line ranges.
- **Cohort** — conceptually related layers, usually spanning several files. Carries a title,
  a summary, a `kind`, and a `risk`.
- **Reading order** — array position at both levels *is* the order. Dependency-first:
  introduce the thing, then the change that needed it, then the plumbing, then the tests;
  generated files and docs last.
- **Scaffolding** — hunks classified as not worth a human's attention (§4). Present, and
  reachable, but out of the reading order and out of the token budget.

A diff over four files becomes:

```
1  Add a token clock port                       feature   low
     1.1  Introduce the TokenClock interface     auth/clock.ts
2  Accept tokens expiring exactly now           fix       medium
     2.1  Fix the boundary comparison            auth/token.ts
     2.2  Thread the clock through the caller    http/middleware.ts, http/server.ts
3  Cover the boundary case                      test      low
     3.1  Add expiry tests                       test/token.test.ts
```

**Ordering is the product.** Everything else supports it.

---

## 2. UI surfaces — native VS Code, no bespoke diff renderer

| Surface | VS Code API | Why |
|---|---|---|
| Stack sidebar | `TreeDataProvider` in a dedicated view container | Two-level tree (cohort → layer → file), glyphs and counts via `TreeItem.description`/`iconPath`; **`TreeItemCheckboxState`** gives "reviewed" ticks for free |
| Reviewed / comment badges | `FileDecorationProvider` on a `changestack:` URI scheme | Colour + badge on tree rows without repainting the tree |
| Code | Built-in diff editor: `vscode.diff` for one file, **`vscode.changes`** (multi-diff editor) for a whole layer or cohort in one scrollable editor | Real syntax highlighting, real LSP, go-to-definition, the user's own keybindings. Zero diff-rendering code to own |
| Base side of the diff | `TextDocumentContentProvider` for `changestack:` serving `git show <rev>:<path>` | Read-only, no checkout, no temp files |
| New side | The **real file** for worktree reviews; a `changestack:` blob for staged/range/PR | LSP attaches and a typo can be fixed in place during a worktree review; other people's branches are never checked out behind the user's back |
| Layer scoping | `TextEditorDecorationType` dimming out-of-layer regions + `revealRange` on the layer's first hunk | Honest approximation of "diff scoped to the active layer" without hiding code |
| Comments | `comments.createCommentController` + `commentingRangeProvider` | Native threads on the diff editor — the same interaction people already know from the GitHub PR extension |
| Walkthrough | Virtual markdown document opened in preview | Renders diagrams (Mermaid) and links; nothing custom to maintain |
| Ask | **Chat participant** `@changestack` (`chat.createChatParticipant`) | Streaming, follow-ups, markdown, code links, all native. Fallback to an output channel if the Chat view is unavailable |
| Progress / cost | `OutputChannel` (`Change Stack`) + `window.withProgress` | Every model call, its timing, its tokens, its failures |

No webview is written in v1.

### Navigation

Commands, all bound under a `changestack.active` context key so nothing leaks into normal
editing:

| Command | Default binding | Behaviour |
|---|---|---|
| `nextHunk` / `prevHunk` | `alt+j` / `alt+k` | Crosses file *and* layer *and* cohort boundaries on its own, so one key walks an entire review in reading order |
| `nextLayer` / `prevLayer` | `alt+shift+j` / `alt+shift+k` | Lands on the layer's first unreviewed hunk |
| `toggleReviewed` | `alt+m` | Marks the hunk under the cursor |
| `markLayerReviewed` | `alt+shift+m` | Marks the layer and advances |
| `comment` | `alt+c` | Opens a comment thread at the cursor |
| `ask` | `alt+a` | Opens chat scoped to the hunk (or layer with a modifier) |
| `walkthrough` | `alt+s` | Opens the markdown walkthrough |
| `focusMode` | `alt+z` | Hides the sidebar and panel — CodeRabbit's `Z` |

---

## 3. Architecture

```
change-stack-vscode/
├── package.json                 -- contributes: viewsContainers, views, commands,
│                                   keybindings, chatParticipants, configuration
├── src/
│   ├── extension.ts             -- activate/deactivate, wiring only
│   ├── git/
│   │   ├── repo.ts              -- root, --git-common-dir, merge-base, worktree detection
│   │   ├── source.ts            -- diff acquisition: worktree | staged | range | pr
│   │   └── parse.ts             -- unified diff -> files + hunks + line maps + identity
│   ├── model/
│   │   ├── types.ts             -- Review, Cohort, Layer, Hunk, Comment
│   │   ├── heuristic.ts         -- non-AI cohorts: the always-available baseline
│   │   ├── noise.ts             -- scaffolding classifier: generated, lockfiles, Nx
│   │   └── merge.ts             -- validate + reconcile model output against the hunk set
│   ├── agent/
│   │   ├── provider.ts          -- Provider interface + registry + capabilities
│   │   ├── providers/
│   │   │   ├── claude.ts        -- CLI adapter: structured + streaming (v1)
│   │   │   └── vscodeLm.ts      -- vscode.lm adapter: Copilot &co (V7)
│   │   ├── queue.ts             -- concurrency cap, per-review job tracking, cancel-all
│   │   ├── cache.ts             -- content-hash keyed, on disk
│   │   ├── json.ts              -- fence strip, parse, shape-validate, one repair retry
│   │   ├── digest.ts            -- budget-aware digest of a diff for clustering
│   │   └── prompts/             -- versioned: summary.ts, cluster.ts, ask.ts
│   ├── state/
│   │   ├── store.ts             -- atomic read/write under .git
│   │   └── anchor.ts            -- re-anchoring across a rebase
│   ├── ui/
│   │   ├── tree.ts              -- TreeDataProvider + checkboxes
│   │   ├── decorations.ts       -- FileDecorationProvider + editor dimming
│   │   ├── content.ts           -- TextDocumentContentProvider for changestack:
│   │   ├── diff.ts              -- opening vscode.diff / vscode.changes, per-file cache
│   │   ├── nav.ts               -- cursor -> hunk mapping, next/prev across boundaries
│   │   ├── comments.ts          -- CommentController
│   │   ├── walkthrough.ts
│   │   └── chat.ts              -- chat participant
│   ├── github/
│   │   ├── pr.ts                -- gh: resolve, fetch diff, no-PR-for-branch
│   │   └── submit.ts            -- POST a review with inline comments
│   └── export.ts                -- markdown
└── test/
    ├── unit/                    -- vitest: parse, identity, heuristic, merge, anchor
    ├── fixtures/                -- .diff corpus, one per edge case
    ├── scaffolding/             -- real generator-run diffs + expected classification
    ├── eval/                    -- real diffs + hand-written expected orderings
    └── integration/             -- @vscode/test-cli
```

Bundled with esbuild. `git` and `gh` are invoked with `child_process.spawn` — always async,
never `execSync`. The built-in Git extension API is used only for repository discovery when
present, with `git rev-parse` as the fallback.

### Data model

```ts
type Review = {
  id: string;                    // sha1(repoRoot + spec) — keyed by spec, not resolved revs
  source: { kind: 'worktree'|'staged'|'range'|'pr'; base: string; head: string; pr?: number };
  files: FileChange[];
  hunks: Record<string, Hunk>;   // by hunkId
  cohorts: Cohort[];             // array position = reading order
  comments: Comment[];
  marks: Record<string, 'reviewed'>;
  meta: { createdAt: number; updatedAt: number; promptVersion: number; schema: 1 };
};

type Hunk = {
  id: string;                    // sha256(path + '\0' + normalizedBody).slice(0,16)
  path: string; oldStart: number; oldCount: number; newStart: number; newCount: number;
  lines: string[];               // raw diff lines with +/-/space prefix
  symbol?: string;               // enclosing function/class
  stats: { added: number; removed: number };
  synthetic?: 'binary'|'rename'|'mode'|'empty';
};

type Cohort = {
  id: string; title: string; summary: string;
  kind: 'feature'|'fix'|'refactor'|'plumbing'|'test'|'config'|'docs'|'generated';
  risk: 'low'|'medium'|'high'; riskReason?: string;
  layers: Layer[];               // array position = reading order
  origin: 'ai'|'heuristic';
};

type Layer = { id: string; title: string; summary: string; hunkIds: string[] };

type Comment = {
  id: string; hunkId: string; offset: number; side: 'old'|'new';
  body: string; orphaned: boolean; moved: boolean; createdAt: number;
  github?: { reviewCommentId: number };
};
```

**Hunk identity is content-based, never positional.** `normalizedBody` is the `+`/`-` lines
only — no `@@` header, no context lines, no trailing whitespace. Two identical hunks in one
file collide and are disambiguated with an ordinal suffix (`<id>:2`). A file with no textual
hunks (binary, pure rename, chmod, added-empty) gets one synthetic hunk, otherwise the change
is invisible in the stack and impossible to mark reviewed.

---

## 4. Scaffolding detection

A generated diff is the loudest thing in a review and the least worth reading. An Nx
`nx g @nx/angular:library` run produces a dozen files — `project.json`, `tsconfig.*.json`,
`.eslintrc.json`, `jest.config.ts`, a barrel `index.ts`, a stub component and its spec — plus
edits to `nx.json` and `tsconfig.base.json`. None of it rewards attention, all of it is
large, and if it reaches the clustering prompt it eats the token budget that the actual
change needed and drags the ordering toward whatever the generator touched.

So the classifier runs **before** anything else, in `src/model/noise.ts`, deterministically
and locally. No model call: the whole point is not to spend tokens on files nobody reads.

### Signals, in order of trust

1. **`.gitattributes`** — `linguist-generated=true` or `-diff`. The repository has already
   said so; nothing else needs to.
2. **In-file markers** in the first few lines of the new side: `@generated`, `GENERATED
   CODE — DO NOT EDIT`, `Code generated by ... DO NOT EDIT.`, `autogenerated`,
   `<auto-generated>`. Established conventions across Go, protobuf, GraphQL codegen,
   OpenAPI, .NET and Prisma.
3. **Lockfiles and vendored trees** — `*.lock`, `package-lock.json`, `pnpm-lock.yaml`,
   `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock`, `vendor/`, `third_party/`, `dist/`,
   `build/`, `out/`, `.angular/`, `coverage/`, `__snapshots__/`, `*.min.js`, `*.map`.
4. **Toolchain manifests the workspace itself declares.** Read `nx.json`, `project.json`,
   `workspace.json`, `angular.json`, `turbo.json`, `tsconfig.base.json` from the repo and
   treat the config files they own as scaffolding — `project.json`, `.eslintrc.json`,
   `jest.config.ts`, `vite.config.ts` and `tsconfig.*.json` under a project root, plus the
   registry edits a generator makes to `nx.json` and `tsconfig.base.json` path mappings.
   This is what makes the feature specifically good on an Nx monorepo rather than generically
   good on lockfiles.
5. **Scaffold shape.** A set of files *added in one diff* under a directory that did not
   exist before, matching a known generator's file set (a `project.json` beside a
   `tsconfig.lib.json` beside an `index.ts` re-exporting exactly one thing), where every file
   is an addition and none is edited. A generated library is recognised by its silhouette
   even when no single file is individually suspicious.
6. **Shape of the content**, last and weakest: a hunk that is entirely additions, over a size
   threshold, with a mean line length or a repetition ratio that no hand-written code has.
   Catches the generated artefact nobody thought to name.

Signals 1–3 are certain. 4–6 are heuristic and produce a *reason string* — `"nx project
config"`, `"generated marker"`, `"lockfile"` — that is always shown, because a classifier
that hides files without saying why is a classifier nobody trusts.

### What classification changes

Scaffolding hunks are **not deleted, not hidden, and never auto-marked reviewed** — a tick
the human did not put there is the same lie as a tick that survived an edit.

- They collect into a single trailing cohort, `Scaffolding · 14 files`, collapsed by default.
- They are excluded from the progress denominator: `reviewed 6/9` counts what a person is
  expected to read.
- `nextHunk` skips them; entering the cohort deliberately walks them normally.
- **They are excluded from the pass-2 digest and get no pass-1 summary.** This is the
  measurable win: the clustering prompt sees the change, not the generator's output, and the
  token budget goes to the hunks that need it. The digest says only
  `(14 hunks classified as scaffolding: nx project config, lockfile)` so the model knows
  they exist and does not try to account for them.
- The heuristic ordering already sends `generated` and `docs` cohorts to the tail;
  scaffolding sits after both.

### Escape hatches

- `changestack.scaffolding.patterns` — extra globs, and `!`-prefixed globs to force a path
  back into the review.
- A **"Not scaffolding"** action on any tree row, recorded per-repository in the state file,
  so a repository where `project.json` genuinely matters teaches the tool once.
- `changestack.scaffolding.mode`: `"collapse"` (default) · `"inline"` (classify but leave in
  the reading order) · `"off"`.
- Every decision is logged with its reason, so a wrong call is visible rather than mysterious.

### Testing it

Fixture diffs from real generator runs — `nx g @nx/angular:library`,
`ng generate component`, a `pnpm-lock.yaml` bump, a protobuf regeneration, a Prisma client —
each with a hand-written expected classification, scored for **precision above recall**:
misclassifying real code as scaffolding costs a review; missing one generated file costs
nothing. Precision is the number that gates the milestone.

---

## 5. The Claude adapter — the v1 provider

Uses the `claude` CLI the user is already signed in to. No API key, no hosted service.

**Structured tier** (summaries, clustering) — a plain model call, no agent loop, no tools:

```
MAX_THINKING_TOKENS=0 claude -p --output-format json --model <model> \
  --tools "" --system-prompt <prompt> --setting-sources "" --strict-mcp-config
```

Prompt body on stdin. Each flag earns its place:

- `--tools ""` — nothing to approve, nothing to wait on.
- `--system-prompt` **replaces** Claude Code's agent system prompt rather than appending;
  a summariser has no use for agent instructions and they dominate the input.
- `--setting-sources ""` — without it the CLI loads the user's settings, **their hooks**,
  and the reviewed repository's `CLAUDE.md` into every call. A repository under review is
  not a source of instructions this extension should obey: a `CLAUDE.md` saying "always
  answer in French" would otherwise do exactly that to every summary.
- `--strict-mcp-config` — the user's MCP servers are not ours to start for a call that
  cannot use them.
- `MAX_THINKING_TOKENS=0` — asked for one sentence, thinking costs many seconds and buys
  nothing. Configurable per tier; kept for the hard tier.

**Streaming tier** (ask), where reading the surrounding repo is the point:

```
claude -p --output-format stream-json --include-partial-messages --verbose \
  --tools Read,Grep,Glob --permission-mode dontAsk --add-dir <repoRoot> --model <model>
```

`--verbose` is mandatory: the CLI refuses `stream-json` without it. The tool set is
**read-only by design** — a review tool must never edit the code it is reviewing — and
`--add-dir` scopes it to the repository under review. Tool calls are surfaced in the chat
response (`› Grep tokenExpiry`) so a pause has a visible reason.

**Follow-ups resume rather than restate.** The first question carries the diff and records
the conversation under `--session-id`; every follow-up passes `--resume` and sends only the
question, so the diff stays in the server-side prompt cache.

Model tiers map to configuration, not hardcoded: `fast` → Haiku (per-file summaries),
`smart` → Sonnet (clustering, ask), `deep` → Opus (reserved).

**JSON discipline.** Output is fence-stripped, parsed, and shape-validated. On failure: one
repair request quoting the parse error; on second failure, log and fall back to the
heuristic for that pass. Raw model text never reaches a structured code path.

**Cancellation.** Every request carries its review id; closing a review kills all of them.
A closed review must not leave a `claude` process talking to the user's account.

### AI passes

| Pass | Trigger | Tier | Input | Output |
|---|---|---|---|---|
| 0 heuristic | instant, local | — | hunks | baseline cohorts, rendered immediately |
| 1 map | on open, per file, parallel | fast | one file's hunks | 1–2 sentence file summary |
| 2 reduce | on open, once | smart | digest of all hunks + pass-1 summaries | cohorts, layers, order, risk, notes |
| 3 ask | `alt+a` / chat | smart | question + hunk or layer + read-only tools | streamed prose |

Pass 2 receives a **digest**, not the raw diff: per hunk, its label (`h1`, `h2` …), path,
enclosing symbol, ±counts, and its first few changed lines, plus what pass 1 said about each
file. A 3000-line diff digests to a few thousand tokens. Detail is shed in order of what the
model can most afford to lose — code samples shrink, then go — but **never the structure**:
a hunk missing from the digest is a hunk the model cannot place. Short labels rather than
content hashes, so an invented label is obviously invalid rather than plausibly real;
`merge.ts` substitutes paths back into every title and summary before a human sees them.

### Pass 2 contract

```json
{
  "summary": "two to four sentences on the change set as a whole",
  "cohorts": [{
    "id": "c1", "title": "...", "summary": "...", "kind": "fix",
    "risk": "medium", "riskReason": "omitted when low",
    "layers": [{ "id": "c1l1", "title": "...", "summary": "...", "hunks": ["h1","h2"] }]
  }],
  "notes": ["things worth attention that belong to no single cohort"]
}
```

Enforced in `merge.ts`, on any output however malformed:

- Unknown hunk labels are dropped; duplicates keep their first occurrence.
- Every hunk appears exactly once — missing ones are collected into a trailing
  "Unclassified" cohort.
- Empty layers and empty cohorts are removed.
- Model order is preserved with exactly one stable post-pass: `generated` and `docs` cohorts
  move to the end. A lockfile is never cohort #1, whatever the model thinks.
- A clustering that organised nothing (everything in one cohort, or one cohort per file) is
  **declined**, and the heuristic stack stays. It is also not written to the cache — a
  schema-valid non-answer cached is a known-bad result replayed on every open.

The model proposes; `merge.ts` disposes.

### Degradation

| Condition | Behaviour |
|---|---|
| AI disabled in settings | heuristic cohorts, no summaries. Everything else works |
| selected provider unavailable (not installed, not signed in) | same, plus one notification naming the provider and the reason, never repeated |
| Call fails or times out | that item keeps its heuristic title; the error goes to the output channel, not a popup |
| Malformed JSON | one repair retry, then heuristic for that pass |
| Diff over budget | per-file digests only; oversized files become their own cohorts |
| Not a git repo | one clean error, no partial UI |

**AI failure degrades quality, never availability.**

---

## 6. Providers — Claude first, not Claude only

v1 ships one provider. The point of this section is that shipping one does not bake one in:
a reviewer who pays for Copilot, Codex, Gemini or a local model should be able to point the
extension at what they already have.

### The seam

Everything model-specific lives behind one interface. `queue.ts`, `cache.ts`, `json.ts`,
`digest.ts` and every prompt are provider-neutral and stay that way.

```ts
type Capabilities = {
  structured: boolean;                    // can be asked for JSON and usually complies
  streaming: boolean;                     // can emit tokens as they are produced
  repoTools: boolean;                     // can read the repository while answering
  models: { fast?: string; smart?: string; deep?: string };
  maxInputChars: number;                  // drives the digest budget
};

interface Provider {
  readonly id: string;                    // 'claude' | 'vscode-lm' | 'cli' | ...
  capabilities(): Capabilities;
  available(): Promise<{ ok: boolean; reason?: string }>;   // installed AND authenticated
  structured(req: Request, token: CancellationToken): Promise<string>;
  stream(req: Request, token: CancellationToken): AsyncIterable<Chunk>;
}

type Request = {
  tier: 'fast' | 'smart' | 'deep';
  system: string;                         // plain prose + a JSON contract, no dialect
  input: string;
  tools?: ('readFile' | 'search' | 'listFiles')[];   // capabilities, not tool names
  cwd?: string;
  session?: { id: string; resume?: boolean };
};
```

Two things make this hold rather than leak:

- **Prompts are prose and a JSON shape, never provider syntax.** No XML tag conventions, no
  model-specific formatting, no assumption about thinking blocks.
- **Tools are named by capability, not by product.** `Read`, `Grep` and `Glob` are Claude
  Code's names; the request asks for `readFile` and `search`, and each adapter maps those to
  whatever it actually has — or declares `repoTools: false`, and Ask degrades to
  diff-only and says so in the chat response.

The registry above the interface keeps the queue, the disk cache, the retry and JSON-repair
loop, and cancel-on-close. Adapters stay dumb: call, parse, report. A provider that fails is
a provider that degrades to the heuristic, exactly like Claude failing.

### The v1 adapter and the ones after it

| Adapter | Milestone | How it authenticates | Notes |
|---|---|---|---|
| `claude` (§5) | V5 | the CLI the user is already signed in to | full capabilities |
| `vscode-lm` | **V7** | the user's Copilot or other chat-model subscription, through `vscode.lm.selectChatModels()` | no subprocess, no PATH, no API key; `repoTools` implemented by the extension as `LanguageModelChatTool`s over the same read-only surface |
| `cli` (generic) | post-v1 | whatever CLI the user configures | a command template with `{system}`, `{model}`, `{input}` placeholders and a declared output format (`text` or a JSON pointer). Covers `codex`, `gemini`, `opencode`, `cursor-agent` and anything shaped like them without an adapter each |
| `openai-compatible` | post-v1 | an endpoint and a key the user supplies | reaches OpenRouter, a local Ollama, or a self-hosted gateway. The answer for anyone who cannot send code off the machine |

**`vscode-lm` lands in V7, before the interface is declared stable.** Building an abstraction
against a single implementation is how the abstraction ends up wrong; the second adapter is
the test of the first, and it is cheap — no process, no PATH probing, and it is the one that
covers the largest population of "a subscription they already have".

### Configuration

```jsonc
"changestack.provider": "claude",
"changestack.providers": {
  "claude": { "command": "claude", "models": { "fast": "haiku", "smart": "sonnet" } },
  "vscode-lm": { "models": { "fast": "gpt-4o-mini", "smart": "gpt-4o" } }
},
// per-pass override: a cheap local model for summaries, a good one for the ordering
"changestack.passes": { "summaries": "vscode-lm", "clustering": "claude", "ask": "claude" }
```

Per-pass routing is the reason the tiers exist. Summaries are twenty small independent calls
and the cheapest thing to run locally; clustering is one call that decides the whole product
and deserves the best model available. The eval harness (§10) runs per provider, so
"is the local model good enough to order a diff" is a number rather than a guess.

`Change Stack: Doctor` lists every provider, whether it is installed, whether it is
authenticated, and what it can do — so an unavailable provider is a visible fact rather than
a silent fallback.

### Where the diff goes

Choosing a provider is choosing where the code under review is sent. The setting is
documented in exactly those terms, the first run says which provider is about to receive the
diff, and the `openai-compatible` and local options exist so that "nowhere" is a real answer.

---

## 7. Persistence and anchoring

State lives at `<git-common-dir>/changestack/<reviewId>.json` — inside `.git`, so it is
never committed and never dirties the worktree, and it is found again from any worktree of
the repository. Written atomically (temp file, then rename) so a crash mid-write leaves the
previous state intact.

Keyed by the **spec**, not by resolved revisions: a review of `main...HEAD` has to survive
`main` moving on, or every push would silently start a new review and discard progress.

On refresh, every anchor is matched against the fresh parse:

1. Exact hunk id → certain.
2. No match, same file, ≥80% line similarity → `moved`. A guess.
3. Otherwise → `orphaned`.

Similarity compares added lines only with added lines, so a line and its own deletion cannot
vouch for each other; identical lines match first, and the remainder is paired by common
prefix and suffix with a floor, so unrelated lines cannot accumulate into a match.

**Marks and comments treat `moved` differently, deliberately.** A mark is carried only by an
exact match — a tick that survives an edit is a lie, and a lie about what has been reviewed
is worse than no marks at all. A comment *is* carried by a moved match and flagged as such,
because losing the note entirely is worse than showing it two lines off. Orphaned comments
get their own sidebar section to re-pin or discard; they are never silently dropped. Refresh
reports what it did: `refreshed · 5 marks kept · 2 changed · 1 gone`.

---

## 8. GitHub pull requests

Read through `gh`, which the user is already authenticated to.

- `gh pr view <n> --json number,baseRefName,headRefOid,title,body` resolves the review; with
  no argument, the PR for the current branch.
- The head is fetched into `refs/changestack/pr-<n>` and reviewed against the **merge base**
  of its target branch — what the author asked to have merged, not a comparison with whatever
  that branch has done since. Nothing is checked out.
- Both diff sides are read-only `changestack:` blobs.

Submitting a review posts inline comments using the line-based form of GitHub's API
(`line` + `side`, not the fragile diff-`position` arithmetic):

```
gh api -X POST repos/{owner}/{repo}/pulls/{n}/reviews \
  -f body='<summary>' -f event=COMMENT \
  -f 'comments[][path]=...' -f 'comments[][line]=...' -f 'comments[][side]=RIGHT' ...
```

`event` is chosen by the user — `COMMENT`, `APPROVE`, or `REQUEST_CHANGES` — in a quick
pick, and the whole payload is shown for confirmation before anything is sent. Comments that
have already been posted record their `reviewCommentId` so a second submission updates rather
than duplicates.

---

## 9. Milestones

**Ordering rule: V1–V4 make the extension useful with AI switched off entirely.** AI does not
land until that is true — if walking a multi-file cohort with the keyboard is awkward, the
concept fails regardless of clustering quality.

### V0 — Scaffold
TypeScript + esbuild bundle; `vitest` for pure logic and `@vscode/test-cli` for integration;
view container and empty tree; `changestack.review` command; a `Change Stack: Doctor` command
reporting git, `gh`, `claude`, and their auth state.
**Done when:** `F5` opens a dev host, the view appears, running the command outside a git
repository gives one clean error and no partial UI.

### V1 — Git and diff core (`src/git/`, no UI)
Repo resolution (root, `--git-common-dir`, worktree detection, three-dot merge-base);
async diff acquisition for `worktree` / `staged` / `range`; unified-diff parser producing
files, hunks and old/new line maps; every edge case — renames, copies, mode changes, binary,
added/deleted, `\ No newline`, CRLF; content-based hunk identity with ordinal
disambiguation; **untracked files** synthesised as added-file diffs (`git diff HEAD` cannot
see them, and a brand new file is usually the thing most worth reading); enclosing-symbol
lookup from the document symbol provider, degrading to nothing.
**Done when:** parser output is asserted exactly against the fixture corpus, a 10k-line diff
parses in under 150 ms, and hunk ids are stable across a rebase fixture and change when a
body changes.

### V2 — The review UI, no AI
Heuristic cohorts (group by file, pair test↔source, follow renames, classify `kind` by path,
order feature/fix/refactor → plumbing → test → docs/generated); `TextDocumentContentProvider`;
diff opening — `vscode.diff` for one file and `vscode.changes` for a layer or cohort, with a
per-file buffer cache; two-level tree with counts and glyphs; cursor→hunk mapping and
`nextHunk` crossing file, layer and cohort boundaries; keybindings gated on a context key;
out-of-layer dimming; teardown that leaves the editor exactly as it was found.
Plus **`noise.ts` per §4** — signals 1–4, the trailing `Scaffolding` cohort, exclusion from
the progress denominator, `nextHunk` skipping, the reason string on every row, and the
"Not scaffolding" override. Signals 5 and 6 follow once 1–4 are measured; they are the ones
that can be wrong.
**Spike first:** confirm `vscode.changes` accepts `[uri, originalUri, modifiedUri][]` on
1.135 and that comment threads attach to its panes; fall back to per-file `vscode.diff` if
not.
**Done when:** on a real 20-file branch diff, every hunk can be walked with one key, never
touching a file picker; and on a fresh `nx g @nx/angular:library` diff the review opens on
the code, with the generator's output collapsed into one labelled cohort and no hand-written
file misclassified.

### V3 — State, marks, refresh, anchoring
Store with schema version and atomic write; marks via tree checkboxes and `alt+m`, with
progress counters; `refresh` re-diffs and re-anchors; fuzzy re-anchor per §7; `resume` and a
review picker.
**Done when:** mark 5 of 9 hunks, have the author amend one marked and one unmarked hunk,
refresh — the amended marked hunk resets to unreviewed, the other four stay ticked, nothing
else moves. Anchoring has its own suite against real rebase fixtures; if those specs are not
convincing, ship exact-match only and orphan the rest.

### V4 — Comments and export
`CommentController` with a `commentingRangeProvider` over hunk ranges; threads anchored to
`{hunkId, offset, side}`, persisted, edited and deleted; orphaned-comment section; markdown
export grouped by cohort with `file:line` references.
**Done when:** comments survive a refresh and a full quit/resume cycle, and the export reads
as a review someone else could act on.

### V5 — Provider layer, Claude structured tier, pass 1
The `Provider` interface and registry per §6, with the Claude CLI as its only implementation;
queue with a concurrency cap and cancel-on-close; typed errors from exit code and stderr;
JSON hygiene with one repair retry; disk cache keyed by
`sha1(promptVersion + model + inputDigest)`, size-capped and clearable; per-file summaries
rendered into the tree as each lands — scaffolding files are not summarised at all; output
channel with timings, tokens and failures.
**Done when:** summaries stream in without blocking a keystroke, reopening the same review is
a cache hit with zero subprocesses, and closing mid-flight leaves no `claude` process behind.

### V6 — Clustering (the reason the extension exists)
Digest builder — scaffolding hunks enter it as a single counted line, never as content;
versioned pass-2 prompt and contract; `merge.ts` with the full validation list; **exactly one announced re-render** when clustering lands, with the cursor staying on
the hunk being read; walkthrough markdown; `npm run eval`.
**Build the eval harness before tuning the prompt**, or prompt changes get judged by vibes.
It scores two things over pairs of hunks against a hand-written expected grouping —
**grouping** (do the two agree these belong together) and **order** (for hunks in different
groups, are they read in the expected order) — both reported against the heuristic baseline,
which is the number clustering has to beat to be worth anything.
**Done when:** on three real PRs the order is defensibly better than alphabetical and
recorded as fixtures, and every adversarial fixture (truncated JSON, invented labels,
duplicate labels, one giant cohort, empty cohorts) still yields a complete, correct partition
of the hunk set.

### V7 — Ask, and the second provider
Chat participant `@changestack` with streaming, tool-call surfacing, and follow-ups on a
resumed session; scoped to the hunk or the layer under the cursor; cancellation.
Then the **`vscode-lm` adapter** (§6): model selection through `vscode.lm.selectChatModels()`,
`readFile`/`search` implemented as `LanguageModelChatTool`s over the same read-only surface,
per-pass routing in settings, and provider status in `Doctor`. Whatever the second adapter
cannot express is a defect in the interface, and the interface — not the adapter — gets
changed.
**Done when:** the first token appears in about two seconds, follow-ups are visibly cheaper
than the first question in the output channel, and a full review runs end to end on Copilot
models with no `claude` binary on PATH.

### V8 — Pull requests
`gh` source, merge-base resolution, no-PR-for-branch handling, read-only blob sides; review
submission with inline comments and a confirmation preview; GitHub "viewed" state read on
open.
**Done when:** a PR from a branch that is not checked out reviews end to end, and its
comments arrive on GitHub anchored to the right lines.

---

## 10. Verification

- `npm test` — vitest over `test/unit` (parse, identity, heuristic, merge, anchor) and
  `@vscode/test-cli` over `test/integration` (tree, diff opening, comments, teardown).
- `npm run eval` — clustering grouping and order against the fixture corpus, printed next to
  the heuristic baseline. A prompt change that does not move these numbers did not happen.
  The same command scores scaffolding classification, reporting precision and recall
  separately; precision below the threshold fails the run. `--provider` runs the whole
  harness against any configured provider, so a second model's quality is measured before it
  is recommended.
- Manual, per milestone, in a real repository from a real VS Code — the acceptance check for
  each milestone above, done by hand. A milestone is not done because its tests are green.
- `Change Stack: Doctor` for the environment, and the output channel for what every model
  call cost.
- Process hygiene: `pgrep -f claude` is clean after closing a review mid-flight.

---

## 11. Risks

1. **Clustering quality is the entire product.** If the order is not better than
   alphabetical, nothing else matters. The eval harness lands in V6 before prompt tuning,
   not after.
2. **V2 is the risk milestone, not V6.** Keyboard navigation across a multi-file cohort has
   to feel right; it is used on real diffs before V3 is written.
3. **Anchoring is the most dangerous code here.** A tick on a hunk that changed underneath is
   how a tool loses trust permanently. Exact-match-only is an acceptable ship.
4. **`vscode.changes` is the one API bet.** Spiked at the start of V2, with per-file
   `vscode.diff` as the fallback; nothing else in the plan depends on it.
5. **A false positive in scaffolding detection hides real code.** That is the one failure
   mode of §4 that matters, so signals are ordered by trust, the weak ones ship after the
   strong ones are measured, precision gates the milestone, and nothing is ever hidden
   without a visible reason and a one-click override.
6. **Scope creep into fixing.** The moment it writes patches it stops being a review tool.
   The read-only tool set is a design constraint, not a default.
7. **A provider interface designed against one provider will be wrong.** Mitigated by
   landing `vscode-lm` in V7 rather than "later", by keeping prompts free of any model
   dialect, and by naming tools as capabilities. Providers that cannot do repo tools or
   cannot hold a JSON contract must degrade visibly, not silently produce worse reviews.
8. **Rate limits** on a subscription: aggressive caching, a manual mode for very large diffs,
   and a visible call and token count.

## 12. Open questions

- **Name.** `change-stack` is a placeholder; it is CodeRabbit's term for their feature.
- **Cohort-level vs hunk-level marking.** Both are implemented; which is actually used
  decides how much the anchoring layer has to guarantee.
- **Commit-by-commit review** is deliberately excluded — a different mental model that would
  fork the whole UI. Revisit only if reviewing large PRs proves it necessary.
- **Diagrams.** CodeRabbit renders sequence diagrams and ERDs per layer. Mermaid in the
  walkthrough is cheap to try in V6; whether it earns its tokens is unknown.
