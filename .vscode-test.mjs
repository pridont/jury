import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The window opens on a throwaway repository, which the tests rebuild between cases, and
// every model call goes to the fake CLI in `test/e2e`, never to a real account. `gh` is the
// fake in `test/e2e` too, linked into `fake/bin`, which the harness puts first on PATH.
//
// The temporary folder by its real path: on macOS it is a link out of /var into /private/var,
// git answers with the real path, and a working-tree file named one way is not found the other.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jury-e2e-'));
const workspace = path.join(root, 'repo');
const fake = path.join(root, 'fake');
fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
fs.symlinkSync(path.resolve('test/e2e/fake-gh.mjs'), path.join(fake, 'bin', 'gh'));
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: workspace });

fs.writeFileSync(
  path.join(workspace, '.vscode', 'settings.json'),
  JSON.stringify(
    {
      'jury.providers': {
        claude: { command: path.resolve('test/e2e/fake-claude.mjs'), models: { fast: 'haiku', smart: 'sonnet', deep: 'opus' } },
        'vscode-lm': { models: {} },
      },
      'jury.walkthrough.autoOpen': false,
      'git.enabled': false,
    },
    null,
    2,
  ),
);

export default defineConfig({
  files: 'out/e2e/test/e2e/**/*.test.js',
  workspaceFolder: workspace,
  env: { JURY_FAKE_DIR: fake },
  // VS Code keeps a socket in its user data folder, and a socket path is limited to about 100
  // characters: the default folder, under this checkout, is past that from a worktree.
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    '--ozone-platform=headless',
    `--user-data-dir=${path.join(root, 'user')}`,
  ],
  mocha: { ui: 'tdd', timeout: 30_000 },
});
