// Pure parser/serializer for the Databricks "source" notebook format (no vscode import,
// so it can be unit-tested with plain node).

export const HEADER = '# Databricks notebook source';
const HEADER_RE = /^\uFEFF?\s*#\s*databricks notebook source\s*$/i;
const SEP_RE = /^# COMMAND -{5,}[ \t]*$/m;
const SEP = '# COMMAND ----------';
const MAGIC_RE = /^# MAGIC ?/;
const TITLE_RE = /^# DBTITLE (\d+),(.*)$/;

export type CellKind = 'code' | 'markdown';

export interface DbxCell {
  kind: CellKind;
  language: string; // vscode language id: python | sql | shellscript | scala | r | markdown
  source: string;
  meta: DbxCellMeta;
}

export interface DbxCellMeta {
  title?: string;       // DBTITLE text
  titleFlag?: string;   // the "1" / "0" in "# DBTITLE 1,..."
  magic?: string;       // original magic keyword, e.g. "md-sandbox", "pip", "run"
  magicCell?: boolean;  // python cell stored with "# MAGIC" prefixes (e.g. %pip, %run)
}

export interface DbxNotebook {
  cells: DbxCell[];
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
}

const MAGIC_LANG: Record<string, string> = {
  md: 'markdown',
  'md-sandbox': 'markdown',
  sql: 'sql',
  sh: 'shellscript',
  scala: 'scala',
  r: 'r',
  python: 'python',
};

const LANG_MAGIC: Record<string, string> = {
  markdown: 'md',
  sql: 'sql',
  shellscript: 'sh',
  scala: 'scala',
  r: 'r',
};

// Magics that Databricks stores with "# MAGIC" prefixes inside a python cell.
const PY_MAGICS = new Set(['pip', 'run', 'fs', 'conda', 'python', 'sh', 'sql', 'md', 'md-sandbox', 'scala', 'r', 'lsmagic', 'env', 'config', 'skip']);

export function isDatabricksNotebook(text: string): boolean {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  return HEADER_RE.test(first.replace(/\r$/, ''));
}

function trimBlankLines(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && lines[s].trim() === '') s++;
  while (e > s && lines[e - 1].trim() === '') e--;
  return lines.slice(s, e);
}

export function parse(text: string): DbxNotebook {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  let body = text.replace(/\r\n/g, '\n');
  const trailingNewline = body.endsWith('\n');
  const lines = body.split('\n');
  if (lines.length && HEADER_RE.test(lines[0])) lines.shift();
  body = lines.join('\n');

  const cells: DbxCell[] = [];
  for (const chunk of body.split(SEP_RE)) {
    let cl = trimBlankLines(chunk.split('\n'));
    const meta: DbxCellMeta = {};
    const t = cl.length ? TITLE_RE.exec(cl[0]) : null;
    if (t) {
      meta.titleFlag = t[1];
      meta.title = t[2];
      cl = trimBlankLines(cl.slice(1));
    }
    if (body.trim() === '') break; // header-only file -> no cells
    const nonEmpty = cl.filter((l) => l.trim() !== '');
    if (nonEmpty.length && nonEmpty.every((l) => MAGIC_RE.test(l))) {
      const inner = trimBlankLines(cl.map((l) => l.replace(MAGIC_RE, '')));
      const first = inner[0].trim();
      const m = /^%([\w-]+)\s*(.*)$/.exec(first);
      const magic = m ? m[1].toLowerCase() : '';
      const lang = MAGIC_LANG[magic];
      if (m && lang && lang !== 'python') {
        const rest = inner.slice(1);
        if (m[2]) rest.unshift(m[2]);
        cells.push({
          kind: lang === 'markdown' ? 'markdown' : 'code',
          language: lang,
          source: rest.join('\n'),
          meta: { ...meta, magic: magic !== LANG_MAGIC[lang] ? magic : undefined },
        });
      } else if (magic === 'python') {
        const rest = inner.slice(1);
        if (m && m[2]) rest.unshift(m[2]);
        cells.push({ kind: 'code', language: 'python', source: rest.join('\n'), meta: { ...meta, magic: 'python' } });
      } else {
        // %pip, %run, %fs, ... -> python cell that keeps the magic line verbatim
        cells.push({ kind: 'code', language: 'python', source: inner.join('\n'), meta: { ...meta, magicCell: true } });
      }
    } else {
      cells.push({ kind: 'code', language: 'python', source: cl.join('\n'), meta });
    }
  }
  return { cells, eol, trailingNewline };
}

function magicLines(lines: string[]): string[] {
  return lines.map((l) => (l === '' ? '# MAGIC' : '# MAGIC ' + l));
}

export function serializeCell(c: DbxCell): string {
  const out: string[] = [];
  if (c.meta.title !== undefined) out.push(`# DBTITLE ${c.meta.titleFlag ?? '1'},${c.meta.title}`);
  const src = c.source.replace(/\r\n/g, '\n');
  const srcLines = trimBlankLines(src.split('\n'));
  const lang = c.kind === 'markdown' ? 'markdown' : c.language;
  const magic = LANG_MAGIC[lang];
  if (magic) {
    const kw = c.meta.magic && MAGIC_LANG[c.meta.magic] === lang ? c.meta.magic : magic;
    out.push(...magicLines(['%' + kw, ...srcLines]));
  } else if (lang === 'python' && c.meta.magic === 'python') {
    out.push(...magicLines(['%python', ...srcLines]));
  } else {
    const first = (srcLines.find((l) => l.trim() !== '') ?? '').trim();
    const m = /^%([\w-]+)/.exec(first);
    const isMagic = !!m && !first.startsWith('%%') && (PY_MAGICS.has(m[1].toLowerCase()) || !!c.meta.magicCell);
    out.push(...(isMagic ? magicLines(srcLines) : srcLines));
  }
  return out.join('\n');
}

export function serialize(nb: DbxNotebook): string {
  const parts = nb.cells.map(serializeCell);
  let text = HEADER + '\n' + parts.join(`\n\n${SEP}\n\n`);
  if (nb.trailingNewline && !text.endsWith('\n')) text += '\n';
  if (nb.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  return text;
}
