import * as vscode from 'vscode';

export type Choice<T> = {
  label: string;
  description?: string;
  detail?: string;
  value: T;
};

export type PickOptions<T> = {
  title: string;
  placeholder: string;
  choices: Choice<T>[];
  /** Turn whatever was typed into a value, when it matches nothing on the list. */
  fromText?: (text: string) => { label: string; value: T } | null;
};

/**
 * A list to pick from that still accepts something typed.
 *
 * `showQuickPick` can only return one of its items and an input box can only return text.
 * A reviewer wants both: the branch they touched yesterday is on the list, and the tag they
 * only remember the name of is not — and having to abandon the list to enter that is what
 * makes pickers annoying.
 */
export function pickOrType<T>(options: PickOptions<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    type Item = vscode.QuickPickItem & { value?: T };
    const quickPick = vscode.window.createQuickPick<Item>();

    quickPick.title = options.title;
    quickPick.placeholder = options.placeholder;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    quickPick.items = options.choices;

    const known = new Set(options.choices.map((choice) => choice.label));

    quickPick.onDidChangeValue((text) => {
      const typed = text.trim();
      if (!options.fromText || !typed || known.has(typed)) {
        quickPick.items = options.choices;
        return;
      }
      const custom = options.fromText(typed);
      quickPick.items = custom
        ? [{ label: custom.label, description: 'as typed', value: custom.value, alwaysShow: true }, ...options.choices]
        : options.choices;
    });

    let answered = false;
    quickPick.onDidAccept(() => {
      const picked = quickPick.selectedItems[0];
      answered = true;
      quickPick.hide();
      resolve(picked?.value);
    });

    quickPick.onDidHide(() => {
      quickPick.dispose();
      if (!answered) resolve(undefined);
    });

    quickPick.show();
  });
}
