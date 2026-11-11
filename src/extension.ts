import * as vscode from 'vscode';
import { convertDescribeOutput, findDescriptions, GenerateOptions } from './ddl';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('describeToDdl.convert', convertToNewTab),
    vscode.commands.registerCommand('describeToDdl.replace', replaceInEditor),
    vscode.commands.registerCommand('describeToDdl.convertTerminalSelection', convertTerminalSelection),
  );
}

export function deactivate(): void {}

const NOTHING_FOUND =
  'No psql \\d output found. Select it in an editor (or copy it to the clipboard) and run the command again.';

/** Says why nothing was converted; `text` is what was looked at, when there was any. */
function warnNothingFound(...texts: (string | undefined)[]): void {
  const format = texts.map((t) => (t === undefined ? undefined : findDescriptions(t).unsupported)).find(Boolean);
  void vscode.window.showWarningMessage(
    format
      ? `This is psql's ${format} output, which can't be converted. Print it in psql's default format (\\pset format aligned) and run the command again.`
      : NOTHING_FOUND,
  );
}

/** Selection, else the whole editor when it holds \d output, else the clipboard. */
async function convertToNewTab(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let text: string | undefined;
  if (editor) {
    const selected = editor.selections.filter((s) => !s.isEmpty);
    if (selected.length > 0) {
      text = selected.map((s) => editor.document.getText(s)).join('\n');
    } else if (findDescriptions(editor.document.getText()).recognized) {
      text = editor.document.getText();
    }
  }
  const fromEditor = text !== undefined;
  if (text === undefined) {
    const clipboard = await vscode.env.clipboard.readText();
    if (findDescriptions(clipboard).found) {
      text = clipboard;
    } else {
      warnNothingFound(clipboard, editor?.document.getText());
      return;
    }
  }
  await openResult(text, fromEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
}

async function convertTerminalSelection(): Promise<void> {
  // The terminal API doesn't expose the selection; copying it is what ⌘C / Ctrl+C would do anyway.
  await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
  const text = await vscode.env.clipboard.readText();
  await openResult(text, vscode.ViewColumn.Active);
}

async function openResult(text: string, column: vscode.ViewColumn): Promise<void> {
  const sql = await convert(text);
  if (sql === undefined) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
  await vscode.window.showTextDocument(doc, { viewColumn: column });
}

async function replaceInEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    warnNothingFound();
    return;
  }
  const doc = editor.document;
  const selected = editor.selections.filter((s) => !s.isEmpty);
  const ranges: vscode.Range[] =
    selected.length > 0 ? selected : [new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))];

  const replacements: [vscode.Range, string][] = [];
  for (const range of ranges) {
    const sql = await convert(doc.getText(range));
    if (sql === undefined) {
      return;
    }
    replacements.push([range, sql]);
  }
  const done = await editor.edit((edit) => {
    for (const [range, sql] of replacements) {
      edit.replace(range, sql);
    }
  });
  if (done && selected.length === 0 && doc.languageId === 'plaintext') {
    await vscode.languages.setTextDocumentLanguage(doc, 'sql');
  }
}

/** Returns undefined (after telling the user why) when there is nothing to convert or they cancelled. */
async function convert(text: string): Promise<string | undefined> {
  const found = findDescriptions(text);
  if (!found.found) {
    warnNothingFound(text);
    return undefined;
  }
  const options: GenerateOptions = {
    serialColumns: vscode.workspace.getConfiguration('describeToDdl').get<boolean>('serialColumns', true),
  };
  // Ask for each table the text doesn't name (no title or \d line above its rows).
  options.fallbackNames = [];
  for (const [i, columns] of found.unnamed.entries()) {
    const name = await vscode.window.showInputBox({
      title: found.unnamed.length > 1 ? `Table name (${i + 1} of ${found.unnamed.length})` : 'Table name',
      prompt: `The pasted text doesn't say which table has the columns ${columns}. Enter its name.`,
      placeHolder: 'e.g. orders or public.orders',
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return undefined;
    }
    options.fallbackNames.push(name.trim());
  }
  return convertDescribeOutput(text, options)?.sql;
}
