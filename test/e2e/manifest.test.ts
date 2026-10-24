import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { jury } from './harness.js';

suite('manifest', () => {
  test('every contributed command is registered', async () => {
    await jury();
    const { contributes } = vscode.extensions.getExtension('pridont.jury')!.packageJSON;
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = (contributes.commands as { command: string }[])
      .map((c) => c.command)
      .filter((command) => !registered.has(command));
    assert.deepEqual(missing, []);
  });

  test('every keybinding and menu entry names a contributed command', () => {
    const { contributes } = vscode.extensions.getExtension('pridont.jury')!.packageJSON;
    const contributed = new Set((contributes.commands as { command: string }[]).map((c) => c.command));
    const used = [
      ...(contributes.keybindings as { command: string }[]),
      ...Object.values(contributes.menus as Record<string, { command: string }[]>).flat(),
    ].map((entry) => entry.command);
    assert.deepEqual(
      used.filter((command) => !contributed.has(command)),
      [],
    );
  });
});
