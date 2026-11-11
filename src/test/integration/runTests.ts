/**
 * Runs the integration suite in a separate VS Code instance (its own user data, no other
 * extensions), so the commands, menus, clipboard and terminal are the real ones.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // Started from VS Code's terminal, these would make the test instance run as plain Node
  // or hand its arguments to the running VS Code.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('ELECTRON_') || name.startsWith('VSCODE_')) {
      delete process.env[name];
    }
  }
  const root = path.resolve(__dirname, '../../..');
  // Kept short: VS Code puts a socket under user-data, and macOS limits socket paths to 103 characters.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ddl-test-'));
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [
        '--disable-extensions',
        `--user-data-dir=${path.join(scratch, 'user-data')}`,
        `--extensions-dir=${path.join(scratch, 'extensions')}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--new-window',
      ],
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
