import * as vscode from 'vscode';
import { DbxCell, DbxNotebook, parse, serialize } from './parser';

export const NOTEBOOK_TYPE = 'databricks-notebook';

export class DatabricksSerializer implements vscode.NotebookSerializer {
  private readonly dec = new TextDecoder();
  private readonly enc = new TextEncoder();

  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const nb = parse(this.dec.decode(content));
    const cells = nb.cells.map((c) => {
      const kind = c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
      const cell = new vscode.NotebookCellData(kind, c.source, c.kind === 'markdown' ? 'markdown' : c.language);
      cell.metadata = { databricks: c.meta };
      return cell;
    });
    const data = new vscode.NotebookData(cells);
    data.metadata = { eol: nb.eol, trailingNewline: nb.trailingNewline };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const nb: DbxNotebook = {
      eol: data.metadata?.eol === '\r\n' ? '\r\n' : '\n',
      trailingNewline: data.metadata?.trailingNewline ?? true,
      cells: data.cells.map(
        (c): DbxCell => ({
          kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
          language: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : c.languageId,
          source: c.value,
          meta: { ...(c.metadata?.databricks ?? {}) },
        })
      ),
    };
    return this.enc.encode(serialize(nb));
  }
}
