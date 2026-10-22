import { defineConfig } from '@vscode/test-cli';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The window opens on a throwaway repository, which the tests rebuild between cases, and
// every model call goes to the fake CLI in `test/e2e`, never to a real account.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jury-e2e-'));
const workspace = path.join(root, 'repo');
const fake = path.join(root, 'fake');
fs.mkdirSync(fake);
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
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--ozone-platform=headless'],
  mocha: { ui: 'tdd', timeout: 30_000 },
});
