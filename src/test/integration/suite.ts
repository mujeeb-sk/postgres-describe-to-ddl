/**
 * End-to-end checks inside VS Code: each command reads \d output from where the user has it (a
 * selection, the whole editor, the clipboard, the terminal) and puts the SQL where it should go.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const FIXTURES = path.resolve(__dirname, '../../../test/fixtures');
const read = (f: string) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

async function waitFor<T>(what: string, check: () => T | undefined | null | false, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

type Window = { -readonly [K in keyof typeof vscode.window]: (typeof vscode.window)[K] };

export async function run(): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, body: () => Promise<void> | void) => {
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await body();
      console.log(`  ✔ ${name}`);
    } catch (error) {
      console.log(`  ✖ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
      failures.push(name);
    }
  };

  // The prompts are answered by the test.
  const win = vscode.window as Window;
  const warnings: string[] = [];
  win.showWarningMessage = (async (message: string) => {
    warnings.push(message);
    return undefined;
  }) as Window['showWarningMessage'];
  // Answers to the table name prompts, in order; undefined cancels.
  let typedNames: (string | undefined)[] = [];
  const prompts: string[] = [];
  win.showInputBox = async (options) => {
    prompts.push(`${options?.title}: ${options?.prompt}`);
    return typedNames.shift();
  };

  const ordersText = read('pg17/orders.d.txt');
  const ordersSql = read('pg17/orders.d.sql');
  const userText = read('user/daily_metrics.txt');
  const userSql = read('user/daily_metrics.sql');

  const open = async (content: string, language = 'plaintext') => {
    const doc = await vscode.workspace.openTextDocument({ language, content });
    return vscode.window.showTextDocument(doc);
  };
  /** The SQL editor a command opened. */
  const result = () =>
    waitFor('the SQL tab', () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.languageId === 'sql' && editor.document.isUntitled ? editor : undefined;
    });

  console.log('Postgres \\d to CREATE TABLE integration');

  const ext = vscode.extensions.getExtension('ShaikMohammadMujeeb.postgres-describe-to-ddl');
  await step('the commands and menus are contributed', async () => {
    assert.ok(ext, 'extension not found');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['describeToDdl.convert', 'describeToDdl.replace', 'describeToDdl.convertTerminalSelection']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
    const menus = ext.packageJSON.contributes.menus;
    assert.ok(menus['terminal/context'].some((m: { command: string }) => m.command === 'describeToDdl.convertTerminalSelection'));
    assert.ok(menus['editor/context'].some((m: { command: string }) => m.command === 'describeToDdl.convert'));
  });

  await step('converts the selection into a new SQL tab beside the editor', async () => {
    const editor = await open(`some notes\n\n${ordersText}\nmore notes\n`);
    const start = editor.document.getText().indexOf('                ');
    const end = editor.document.getText().indexOf('more notes');
    editor.selection = new vscode.Selection(editor.document.positionAt(start), editor.document.positionAt(end));
    await vscode.commands.executeCommand('describeToDdl.convert');
    const out = await result();
    assert.strictEqual(out.document.getText(), ordersSql);
    assert.strictEqual(out.viewColumn, vscode.ViewColumn.Two);
    assert.strictEqual(editor.document.getText(), `some notes\n\n${ordersText}\nmore notes\n`, 'the source changed');
  });

  await step('without a selection, converts the whole editor when it holds \\d output', async () => {
    await open(userText);
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.strictEqual((await result()).document.getText(), userSql);
  });

  await step('otherwise converts the clipboard', async () => {
    await vscode.env.clipboard.writeText(ordersText);
    await open('nothing to see here');
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.strictEqual((await result()).document.getText(), ordersSql);
  });

  await step('with no \\d output anywhere, says so', async () => {
    await vscode.env.clipboard.writeText('not psql output');
    await open('nothing to see here');
    warnings.length = 0;
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.match(warnings[0] ?? '', /No psql \\d output found/);
  });

  await step('names the psql format it cannot read', async () => {
    await vscode.env.clipboard.writeText('not psql output');
    await open('<table border="1">\n  <caption>Table &quot;public.t&quot;</caption>\n  <tr>\n    <th align="center">Column</th>\n  </tr>\n</table>\n');
    warnings.length = 0;
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.match(warnings[0] ?? '', /psql's HTML output/);
  });

  await step('does not take a query result on the clipboard for \\d output', async () => {
    await vscode.env.clipboard.writeText(' id | name \n----+------\n  1 | x\n(1 row)\n');
    await open('nothing to see here');
    warnings.length = 0;
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.match(warnings[0] ?? '', /No psql \\d output found/);
    assert.notStrictEqual(vscode.window.activeTextEditor?.document.languageId, 'sql');
  });

  await step('asks for the table name when the paste has none', async () => {
    const rowsOnly = userText.replace(/^test=# .*\n/, '');
    await vscode.env.clipboard.writeText(rowsOnly);
    await open('');
    typedNames = ['app.Metrics'];
    await vscode.commands.executeCommand('describeToDdl.convert');
    const text = (await result()).document.getText();
    assert.ok(text.startsWith('CREATE FOREIGN TABLE app.metrics (\n'), text.slice(0, 80));

    // Cancelling the prompt converts nothing.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await open('');
    typedNames = [undefined];
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.notStrictEqual(vscode.window.activeTextEditor?.document.languageId, 'sql');
  });

  await step('converts many \\d outputs at once into one script', async () => {
    const editor = await open(read('pg17/all_reversed.dplus.txt'));
    await vscode.commands.executeCommand('describeToDdl.convert');
    assert.strictEqual((await result()).document.getText(), read('pg17/all_reversed.dplus.sql'));
    assert.ok(editor.document.getText().startsWith('src=# '));
  });

  await step('asks for the name of each table the paste doesn\'t name', async () => {
    const rowsOnly = userText.replace(/^test=# .*\n/, '').replace(/^Server: .*\n/m, '');
    await open(`${rowsOnly}Server: analytics_server\n\n${rowsOnly}Server: analytics_server\n`);
    prompts.length = 0;
    typedNames = ['daily_metrics', 'weekly_metrics'];
    await vscode.commands.executeCommand('describeToDdl.convert');
    const text = (await result()).document.getText();
    assert.deepStrictEqual(text.match(/^CREATE FOREIGN TABLE \w+/gm), [
      'CREATE FOREIGN TABLE daily_metrics',
      'CREATE FOREIGN TABLE weekly_metrics',
    ]);
    assert.strictEqual(prompts.length, 2);
    assert.match(prompts[1], /^Table name \(2 of 2\): .*columns metric_01, metric_02, metric_03, …/);
  });

  await step('replaces the whole editor in place and switches it to SQL', async () => {
    const editor = await open(ordersText);
    await vscode.commands.executeCommand('describeToDdl.replace');
    await waitFor('the replacement', () => editor.document.getText() === ordersSql);
    await waitFor('SQL mode', () => editor.document.languageId === 'sql');
  });

  await step('replaces each selection with its own SQL', async () => {
    const editor = await open(`${ordersText}\n-- between\n${userText}`, 'sql');
    const text = editor.document.getText();
    const second = text.indexOf('test=#');
    editor.selections = [
      new vscode.Selection(editor.document.positionAt(0), editor.document.positionAt(ordersText.length)),
      new vscode.Selection(editor.document.positionAt(second), editor.document.positionAt(text.length)),
    ];
    await vscode.commands.executeCommand('describeToDdl.replace');
    await waitFor('the replacement', () => editor.document.getText() === `${ordersSql}\n-- between\n${userSql}`);
  });

  await step('converts the selection in the terminal', async () => {
    const write = new vscode.EventEmitter<string>();
    const terminal = vscode.window.createTerminal({
      name: 'psql',
      pty: { onDidWrite: write.event, open: () => write.fire(userText.replace(/\n/g, '\r\n')), close: () => undefined },
    });
    terminal.show();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
    await vscode.commands.executeCommand('describeToDdl.convertTerminalSelection');
    assert.strictEqual((await result()).document.getText(), userSql);
    terminal.dispose();
  });

  if (failures.length) {
    throw new Error(`${failures.length} integration step(s) failed`);
  }
}
