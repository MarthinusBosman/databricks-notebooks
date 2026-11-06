// Launch a real VS Code (downloaded by @vscode/test-electron) with this extension and run test/suite.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dbxnb-ws-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample_notebook.py'), path.join(ws, 'sample_notebook.py'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'helpers.py'), path.join(ws, 'helpers.py'));
  fs.writeFileSync(path.join(ws, 'plain.py'), 'print("not a notebook")\n');
  fs.mkdirSync(path.join(ws, '.vscode'));
  const python = process.env.TEST_PYTHON || path.join(root, '.testenv', 'bin', 'python');
  fs.writeFileSync(
    path.join(ws, '.vscode', 'settings.json'),
    JSON.stringify({ 'databricksNotebook.pythonPath': python, 'security.workspace.trust.enabled': false }, null, 2)
  );
  const withPy = !!process.env.DBX_WITH_PYEXT;
  const settings = { 'databricksNotebook.pythonPath': python, 'security.workspace.trust.enabled': false };
  if (withPy) settings['python.defaultInterpreterPath'] = python;
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
  const extDir = path.join(root, '.vscode-test', 'exts');
  const launchArgs = [ws, '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', '--extensions-dir', extDir];
  if (withPy) {
    const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
    const exe = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION || 'stable');
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(exe);
    require('child_process').spawnSync(cli, [...args, '--extensions-dir', extDir, '--install-extension', 'ms-python.python'], { stdio: 'inherit', env: { ...process.env, DONT_PROMPT_WSL_INSTALL: '1' } });
  } else launchArgs.push('--disable-extensions');
  try {
    await runTests({
      version: process.env.VSCODE_VERSION || 'stable',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs,
      extensionTestsEnv: { DBX_TEST_WS: ws, DBX_WITH_PYEXT: withPy ? '1' : '', DBX_SCREENSHOT: process.env.DBX_SCREENSHOT || '' },
    });
  } catch (e) {
    console.error('Integration tests failed', e);
    process.exit(1);
  }
}
main();
