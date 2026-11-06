import * as vscode from 'vscode';
import { isDatabricksNotebook } from './parser';
import { KernelManager } from './kernel';
import { DatabricksSerializer, NOTEBOOK_TYPE } from './serializer';

const SCHEMES = new Set(['file', 'vscode-remote', 'vscode-userdata']);

/** URIs the user explicitly asked to see as plain text (don't bounce them back to the notebook view). */
const textOverrides = new Set<string>();
const inFlight = new Set<string>();

async function hasHeader(uri: vscode.Uri): Promise<boolean> {
  // Prefer an already-open document (may contain unsaved edits)
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) return isDatabricksNotebook(doc.lineAt(0).text);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return isDatabricksNotebook(new TextDecoder().decode(bytes.slice(0, 256)));
  } catch {
    return false;
  }
}

async function maybeSwitch(tab: vscode.Tab) {
  if (!vscode.workspace.getConfiguration('databricksNotebook').get<boolean>('autoOpen', true)) return;
  if (!(tab.input instanceof vscode.TabInputText)) return; // ignores diffs, notebooks, custom editors
  const uri = tab.input.uri;
  const key = uri.toString();
  if (!SCHEMES.has(uri.scheme) || !uri.path.toLowerCase().endsWith('.py')) return;
  if (textOverrides.has(key) || inFlight.has(key)) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (doc?.isDirty) return; // don't throw away unsaved text edits
  if (!(await hasHeader(uri))) return;
  inFlight.add(key);
  try {
    await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE, {
      viewColumn: tab.group.viewColumn,
      preview: tab.isPreview,
      preserveFocus: !tab.isActive,
    });
    // close the text tab (find it again – tab objects can be stale)
    const stale = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
    if (stale.length) await vscode.window.tabGroups.close(stale, true);
  } finally {
    inFlight.delete(key);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DatabricksSerializer(), {
      transientOutputs: true, // the source format can't store outputs; don't mark the file dirty on run
      transientDocumentMetadata: {},
    })
  );

  const kernels = new KernelManager(context);
  context.subscriptions.push(kernels);
  const kernelsReady = kernels.init().catch((e) => kernels.log.appendLine('[init] ' + e));

  const targetUri = (arg?: vscode.Uri): vscode.Uri | undefined =>
    arg instanceof vscode.Uri
      ? arg
      : vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;

  context.subscriptions.push(
    vscode.commands.registerCommand('databricksNotebook.openAsNotebook', async (arg?: vscode.Uri) => {
      const uri = targetUri(arg);
      if (!uri) return;
      textOverrides.delete(uri.toString());
      const textTabs = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
      await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
      const clean = textTabs.filter((t) => !t.isDirty);
      if (clean.length) await vscode.window.tabGroups.close(clean, true);
    }),
    vscode.commands.registerCommand('databricksNotebook.openAsText', async (arg?: vscode.Uri) => {
      const uri = targetUri(arg);
      if (!uri) return;
      textOverrides.add(uri.toString());
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('databricksNotebook.restartKernel', async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (nb && nb.notebookType === NOTEBOOK_TYPE) await kernels.restart(nb);
    }),
    vscode.commands.registerCommand('databricksNotebook.showLog', () => kernels.log.show()),
    vscode.commands.registerCommand('databricksNotebook.newNotebook', async () => {
      const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'python')]);
      data.metadata = { eol: '\n', trailingNewline: true };
      const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
      await vscode.window.showNotebookDocument(doc);
    }),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const t of [...e.opened, ...e.changed]) maybeSwitch(t);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      // once the user closes the plain-text view, go back to notebook-by-default for that file
      if (!vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === d.uri.toString())))
        textOverrides.delete(d.uri.toString());
    })
  );

  // Handle tabs that were already open when the extension activated.
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) maybeSwitch(t);
  await kernelsReady;
  return { kernels };
}

export function deactivate() {}
