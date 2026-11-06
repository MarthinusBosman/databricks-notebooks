// Runs inside VS Code's extension host.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + what);
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push('ok   ' + name);
  } catch (e) {
    results.push('FAIL ' + name + ': ' + (e && e.stack));
  }
}

function mimes(cell) {
  return cell.outputs.map((o) => o.items.map((i) => i.mime).join('|'));
}
function text(cell) {
  return cell.outputs
    .flatMap((o) => o.items)
    .map((i) => Buffer.from(i.data).toString('utf8'))
    .join('\n');
}

exports.run = async function () {
  const ws = process.env.DBX_TEST_WS;
  const nbUri = vscode.Uri.file(path.join(ws, 'sample_notebook.py'));
  const ext = vscode.extensions.getExtension('local.databricks-notebook-local');
  await ext.activate();

  await test('plain .py stays a text editor', async () => {
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(ws, 'plain.py')));
    await sleep(1500);
    assert.ok(vscode.window.activeTextEditor, 'text editor active');
    assert.ok(!vscode.window.activeNotebookEditor, 'no notebook editor');
  });

  let nb;
  await test('databricks .py auto-opens as notebook', async () => {
    await vscode.commands.executeCommand('vscode.open', nbUri);
    const ed = await until(
      () => vscode.window.activeNotebookEditor && vscode.window.activeNotebookEditor.notebook.uri.fsPath === nbUri.fsPath && vscode.window.activeNotebookEditor,
      15000,
      'notebook editor'
    );
    nb = ed.notebook;
    assert.strictEqual(nb.notebookType, 'databricks-notebook');
    await sleep(500);
    const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath === nbUri.fsPath);
    assert.strictEqual(textTabs.length, 0, 'text tab closed');
  });

  await test('cells parsed', async () => {
    const kinds = nb.getCells().map((c) => (c.kind === vscode.NotebookCellKind.Markup ? 'md' : c.document.languageId));
    assert.deepStrictEqual(kinds, ['md', 'python', 'python', 'python', 'python', 'shellscript', 'python', 'python']);
    assert.strictEqual(nb.cellAt(3).metadata.databricks.title, 'A plot');
  });

  await test('run all -> Jupyter-style outputs', async () => {
    if (!process.env.DBX_WITH_PYEXT)
      await vscode.commands.executeCommand('notebook.selectKernel', { id: 'dbx-local-default', extension: 'local.databricks-notebook-local' });
    else {
      // With the Python extension there's one controller per environment; pick the one for the test venv.
      const api = await vscode.extensions.getExtension('ms-python.python').activate();
      const py = vscode.workspace.getConfiguration('databricksNotebook').get('pythonPath');
      const env = await until(() => api.environments.resolveEnvironment(py), 30000, 'env resolve');
      await sleep(3000);
      const id = 'dbx-local-' + env.id.replace(/[^\w.-]/g, '_').slice(-120);
      results.push('info python-ext env id ' + env.id + ' known=' + api.environments.known.length);
      await vscode.commands.executeCommand('notebook.selectKernel', { id, extension: 'local.databricks-notebook-local' });
    }
    await vscode.commands.executeCommand('notebook.execute', nb.uri);
    const code = nb.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
    await until(() => code.every((c) => c.executionSummary && c.executionSummary.success !== undefined), 180000, 'all cells executed');
    const c = nb.getCells();
    assert.strictEqual(c[1].executionSummary.success, true, 'run cell ok: ' + text(c[1]));
    assert.ok(text(c[2]).includes('helper says 42'), text(c[2]));
    assert.ok(mimes(c[2]).some((m) => m.startsWith('text/html')), 'dataframe html: ' + mimes(c[2]));
    assert.ok(mimes(c[4]).some((m) => m.includes('image/png')), 'plot png: ' + mimes(c[4]));
    assert.ok(text(c[5]).includes('hello from sh'), text(c[5]));
    assert.strictEqual(text(c[6]).trim(), 'progress 2', 'carriage returns: ' + JSON.stringify(text(c[6])));
    assert.strictEqual(c[7].executionSummary.success, false);
    assert.ok(mimes(c[7])[0].includes('application/vnd.code.notebook.error'), mimes(c[7]));
    assert.ok(text(c[7]).includes('boom'));
    assert.ok(c[2].executionSummary.executionOrder >= 1, 'execution order');
    assert.ok(!nb.isDirty, 'running cells should not dirty the file');
    if (process.env.DBX_SCREENSHOT) {
      await vscode.window.showNotebookDocument(nb);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('workbench.action.closePanel');
      for (const [i, cellIdx] of [[1, 0], [2, 4], [3, 7]]) {
        vscode.window.activeNotebookEditor.revealRange(new vscode.NotebookRange(cellIdx, cellIdx + 1), vscode.NotebookEditorRevealType.AtTop);
        await sleep(2500);
        require('child_process').execSync(
          `ffmpeg -loglevel error -y -f x11grab -video_size 1600x1200 -i ${process.env.DISPLAY} -frames:v 1 ${process.env.DBX_SCREENSHOT}_${i}.png`
        );
      }
    }
  });

  await test('restart kernel clears state', async () => {
    await vscode.commands.executeCommand('databricksNotebook.restartKernel');
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "print('HELPER' in globals())", 'python')])]);
    await vscode.workspace.applyEdit(edit);
    const cell = nb.cellAt(nb.cellCount - 1);
    await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: cell.index, end: cell.index + 1 }], document: nb.uri });
    await until(() => cell.executionSummary && cell.executionSummary.success !== undefined, 60000, 'cell run');
    assert.strictEqual(text(cell).trim(), 'False');
  });

  await test('save writes Databricks source format', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.insertCells(nb.cellCount, [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '## Added', 'markdown')])]);
    await vscode.workspace.applyEdit(edit);
    await nb.save();
    const saved = fs.readFileSync(nbUri.fsPath, 'utf8');
    const original = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample_notebook.py'), 'utf8');
    assert.ok(saved.startsWith(original.trimEnd()), 'original content preserved');
    assert.ok(saved.endsWith("# COMMAND ----------\n\nprint('HELPER' in globals())\n\n# COMMAND ----------\n\n# MAGIC %md\n# MAGIC ## Added\n"), JSON.stringify(saved.slice(-200)));
  });

  await test('open as text command', async () => {
    await vscode.commands.executeCommand('databricksNotebook.openAsText', nbUri);
    await until(() => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath === nbUri.fsPath, 10000, 'text editor');
    await sleep(1500);
    assert.ok(vscode.window.activeTextEditor.document.lineAt(0).text.startsWith('# Databricks notebook source'));
    assert.ok(!vscode.window.activeNotebookEditor || vscode.window.activeNotebookEditor.notebook.uri.fsPath !== nbUri.fsPath, 'stayed text');
  });

  console.log('\n' + results.join('\n'));
  const failed = results.filter((r) => r.startsWith('FAIL'));
  if (failed.length) throw new Error(failed.length + ' integration test(s) failed');
};
