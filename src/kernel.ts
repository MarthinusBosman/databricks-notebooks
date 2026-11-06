import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { NOTEBOOK_TYPE } from './serializer';

// ---------------------------------------------------------------------------
// Jupyter message -> VS Code output conversion (mirrors what the Jupyter extension does)
// ---------------------------------------------------------------------------
const MIME_ORDER = [
  'application/vnd.jupyter.widget-view+json',
  '*vnd',
  'application/javascript',
  'text/html',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/markdown',
  'text/latex',
  'application/json',
  'text/plain',
];

function mimeRank(m: string): number {
  const i = MIME_ORDER.indexOf(m);
  if (i >= 0) return i;
  if (m.startsWith('application/vnd.')) return 1;
  return 1.5;
}

function toItem(mime: string, value: unknown): vscode.NotebookCellOutputItem {
  if ((mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif') && typeof value === 'string') {
    return new vscode.NotebookCellOutputItem(Buffer.from(value.replace(/\s/g, ''), 'base64'), mime);
  }
  if (mime === 'application/json' || mime.endsWith('+json')) {
    return vscode.NotebookCellOutputItem.json(value, mime);
  }
  if (Array.isArray(value)) value = value.join('');
  if (typeof value === 'string') return vscode.NotebookCellOutputItem.text(value, mime);
  return vscode.NotebookCellOutputItem.json(value, mime);
}

export function mimeBundleToItems(data: Record<string, unknown>): vscode.NotebookCellOutputItem[] {
  return Object.keys(data)
    .sort((a, b) => mimeRank(a) - mimeRank(b))
    .map((m) => toItem(m, data[m]));
}

/** Terminal-ish handling of carriage returns so progress bars (tqdm etc.) render like Jupyter. */
export function fixCarriageReturns(text: string): string {
  if (!text.includes('\r') && !text.includes('\b')) return text;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      let res = '';
      for (const seg of line.split('\r')) res = seg + res.slice(seg.length);
      while (res.includes('\x08')) {
        const r = res.replace(/[^\x08]\x08/, '').replace(/^\x08+/, '');
        if (r === res) break;
        res = r;
      }
      return res;
    })
    .join('\n');
}

interface TrackedOutput {
  output: vscode.NotebookCellOutput;
  stream?: string;
  text?: string;
}

class CellOutputWriter {
  private outputs: TrackedOutput[] = [];
  private clearOnNext = false;
  private chain: Thenable<void> = Promise.resolve();

  constructor(private readonly exec: vscode.NotebookCellExecution, private readonly displays: Map<string, TrackedOutput[]>) {}

  private q(fn: () => Thenable<void>) {
    this.chain = this.chain.then(fn, fn);
  }

  flush(): Thenable<void> {
    return this.chain;
  }

  private maybeClear() {
    if (this.clearOnNext) {
      this.clearOnNext = false;
      this.outputs = [];
      this.q(() => this.exec.clearOutput());
    }
  }

  private append(t: TrackedOutput) {
    this.outputs.push(t);
    this.q(() => this.exec.appendOutput(t.output));
  }

  handle(msgType: string, c: any) {
    switch (msgType) {
      case 'execute_input':
        if (typeof c.execution_count === 'number') this.exec.executionOrder = c.execution_count;
        return;
      case 'stream': {
        this.maybeClear();
        const name = c.name === 'stderr' ? 'stderr' : 'stdout';
        const mk = (s: string) =>
          name === 'stderr' ? vscode.NotebookCellOutputItem.stderr(s) : vscode.NotebookCellOutputItem.stdout(s);
        const last = this.outputs[this.outputs.length - 1];
        if (last && last.stream === name) {
          last.text = (last.text ?? '') + c.text;
          const item = mk(fixCarriageReturns(last.text));
          const out = last.output;
          this.q(() => this.exec.replaceOutputItems(item, out));
        } else {
          const text = String(c.text ?? '');
          this.append({ output: new vscode.NotebookCellOutput([mk(fixCarriageReturns(text))], { outputType: 'stream' }), stream: name, text });
        }
        return;
      }
      case 'display_data':
      case 'execute_result': {
        this.maybeClear();
        if (msgType === 'execute_result' && typeof c.execution_count === 'number') this.exec.executionOrder = c.execution_count;
        const t: TrackedOutput = {
          output: new vscode.NotebookCellOutput(mimeBundleToItems(c.data ?? {}), {
            outputType: msgType,
            metadata: c.metadata ?? {},
            transient: c.transient ?? {},
          }),
        };
        const did = c.transient?.display_id;
        if (did) this.displays.set(did, [...(this.displays.get(did) ?? []), t]);
        this.append(t);
        return;
      }
      case 'update_display_data': {
        const did = c.transient?.display_id;
        const targets = (did && this.displays.get(did)) || [];
        const items = mimeBundleToItems(c.data ?? {});
        for (const t of targets) {
          // Only outputs belonging to the running cell can be edited through this execution.
          if (this.outputs.includes(t)) this.q(() => this.exec.replaceOutputItems(items, t.output));
        }
        return;
      }
      case 'clear_output':
        if (c.wait) this.clearOnNext = true;
        else {
          this.outputs = [];
          this.q(() => this.exec.clearOutput());
        }
        return;
      case 'error': {
        this.maybeClear();
        const err = { name: String(c.ename ?? 'Error'), message: String(c.evalue ?? ''), stack: (c.traceback ?? []).join('\n') };
        this.append({
          output: new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(err as Error)], { outputType: 'error' }),
        });
        return;
      }
    }
  }

  errorText(name: string, message: string) {
    this.handle('error', { ename: name, evalue: message, traceback: [] });
  }
}

// ---------------------------------------------------------------------------
// Driver process (python/driver.py) wrapper
// ---------------------------------------------------------------------------
interface DoneMsg {
  status: string;
  execution_count: number | null;
}

class StartupError extends Error {
  constructor(message: string, readonly missingDeps: boolean) {
    super(message);
  }
}

export class KernelSession {
  private proc?: cp.ChildProcess;
  private buf = '';
  private seq = 0;
  private handlers = new Map<string, { onMsg: (t: string, c: any) => void; done: (d: DoneMsg) => void }>();
  private ready?: Promise<void>;
  readonly displays = new Map<string, TrackedOutput[]>();
  dead = false;
  onDeath?: (msg: string) => void;
  info = '';

  constructor(readonly python: string, private readonly nbPath: string, private readonly extPath: string, private readonly log: vscode.OutputChannel) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const cfg = vscode.workspace.getConfiguration('databricksNotebook');
      const driver = path.join(this.extPath, 'python', 'driver.py');
      const cwd = this.nbPath ? path.dirname(this.nbPath) : undefined;
      this.log.appendLine(`[kernel] starting ${this.python} ${driver} (cwd ${cwd ?? '-'})`);
      let settled = false;
      const proc = cp.spawn(this.python, ['-u', driver], {
        cwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          DBX_NOTEBOOK_PATH: this.nbPath,
          DBX_NOTEBOOK_CWD: cwd ?? '',
          DBX_SPARK_MODE: cfg.get<string>('spark', 'none'),
          DBX_STARTUP_CODE: cfg.get<string>('startupCode', ''),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      proc.stdout!.setEncoding('utf8');
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (d: string) => this.log.append(d));
      proc.stdout!.on('data', (d: string) => {
        this.buf += d;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            this.log.appendLine('[driver] ' + line);
            continue;
          }
          if (msg.type === 'ready') {
            this.info = `Python ${msg.version}`;
            this.log.appendLine(`[kernel] ready (${msg.python}, ${msg.version})`);
            settled = true;
            resolve();
          } else if (msg.type === 'startup_error') {
            settled = true;
            reject(new StartupError(msg.message, !!msg.missing));
          } else this.dispatch(msg);
        }
      });
      proc.on('error', (e) => {
        this.log.appendLine(`[kernel] failed to spawn: ${e.message}`);
        if (!settled) {
          settled = true;
          reject(new StartupError(`Could not run "${this.python}": ${e.message}`, false));
        }
      });
      proc.on('exit', (code) => {
        this.log.appendLine(`[kernel] driver exited (${code})`);
        const wasDead = this.dead;
        this.dead = true;
        if (!settled) {
          settled = true;
          reject(new StartupError(`Kernel process exited with code ${code} during start-up. See "Databricks Notebook: Show Kernel Log".`, false));
        }
        for (const [, h] of this.handlers) h.done({ status: 'dead', execution_count: null });
        this.handlers.clear();
        if (!wasDead) this.onDeath?.('The kernel process exited.');
      });
    });
    return this.ready;
  }

  private dispatch(msg: any) {
    if (msg.type === 'log') {
      this.log.appendLine('[kernel] ' + msg.message);
      return;
    }
    if (msg.type === 'dead') {
      this.log.appendLine('[kernel] ' + msg.message);
      this.onDeath?.(msg.message);
      return;
    }
    const h = this.handlers.get(msg.id);
    if (!h) return;
    if (msg.type === 'output') h.onMsg(msg.msg_type, msg.content);
    else if (msg.type === 'done') {
      this.handlers.delete(msg.id);
      h.done({ status: msg.status, execution_count: msg.execution_count });
    }
  }

  execute(code: string, language: string, onMsg: (t: string, c: any) => void): Promise<DoneMsg> {
    const id = 'c' + ++this.seq;
    return new Promise<DoneMsg>((done) => {
      if (this.dead || !this.proc?.stdin?.writable) return done({ status: 'dead', execution_count: null });
      this.handlers.set(id, { onMsg, done });
      this.proc.stdin.write(JSON.stringify({ cmd: 'execute', id, code, language }) + '\n');
    });
  }

  interrupt() {
    this.proc?.stdin?.write(JSON.stringify({ cmd: 'interrupt' }) + '\n');
  }

  dispose() {
    const p = this.proc;
    this.dead = true;
    if (!p) return;
    try {
      p.stdin?.write(JSON.stringify({ cmd: 'shutdown' }) + '\n');
      p.stdin?.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (p.exitCode === null) p.kill();
    }, 4000);
  }
}

// ---------------------------------------------------------------------------
// Python environment discovery (via the Python extension when available)
// ---------------------------------------------------------------------------
interface PyEnv {
  id: string;
  label: string;
  description: string;
  python: string;
}

async function pythonApi(): Promise<any | undefined> {
  const ext = vscode.extensions.getExtension('ms-python.python');
  if (!ext) return undefined;
  try {
    const api = ext.isActive ? ext.exports : await ext.activate();
    return api?.environments ? api : undefined;
  } catch {
    return undefined;
  }
}

function defaultPython(): string {
  const cfg = vscode.workspace.getConfiguration('databricksNotebook').get<string>('pythonPath', '');
  return cfg || (process.platform === 'win32' ? 'python' : 'python3');
}

function envLabel(env: any): PyEnv | undefined {
  const exe: string | undefined = env.executable?.uri?.fsPath ?? env.path;
  if (!exe) return undefined;
  const v = env.version;
  const ver = v && v.major !== undefined ? `Python ${v.major}.${v.minor}.${v.micro}` : 'Python';
  const name = env.environment?.name || (env.environment?.folderUri ? path.basename(env.environment.folderUri.fsPath) : '');
  return { id: env.id, label: name ? `${name} (${ver})` : ver, description: exe, python: exe };
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------
export class KernelManager implements vscode.Disposable {
  private controllers = new Map<string, { ctrl: vscode.NotebookController; env: PyEnv }>();
  private sessions = new Map<string, KernelSession>();
  private queues = new Map<string, Promise<void>>();
  private pending = new Map<string, Set<vscode.NotebookCellExecution>>();
  private api: any;
  private disposables: vscode.Disposable[] = [];
  readonly log = vscode.window.createOutputChannel('Databricks Notebook');

  constructor(private readonly context: vscode.ExtensionContext) {}

  async init() {
    this.api = await pythonApi();
    await this.refresh();
    if (this.api) {
      this.disposables.push(this.api.environments.onDidChangeEnvironments(() => this.refresh()));
      if (this.api.environments.onDidChangeActiveEnvironmentPath)
        this.disposables.push(this.api.environments.onDidChangeActiveEnvironmentPath(() => this.updateAffinities()));
    }
    this.disposables.push(
      vscode.workspace.onDidOpenNotebookDocument((nb) => nb.notebookType === NOTEBOOK_TYPE && this.updateAffinity(nb)),
      vscode.workspace.onDidCloseNotebookDocument((nb) => this.disposeSession(nb.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('databricksNotebook.pythonPath') && !this.api) this.refresh();
      })
    );
  }

  private async listEnvs(): Promise<PyEnv[]> {
    if (this.api) {
      const envs: PyEnv[] = [];
      for (const e of this.api.environments.known ?? []) {
        const l = envLabel(e);
        if (l) envs.push(l);
      }
      if (envs.length) return envs;
    }
    const py = defaultPython();
    return [{ id: 'default', label: 'Python (Databricks local)', description: py, python: py }];
  }

  async refresh() {
    const envs = await this.listEnvs();
    const keep = new Set(envs.map((e) => e.id));
    for (const [id, c] of this.controllers) {
      if (!keep.has(id)) {
        c.ctrl.dispose();
        this.controllers.delete(id);
      }
    }
    for (const env of envs) {
      const existing = this.controllers.get(env.id);
      if (existing) {
        existing.env = env;
        existing.ctrl.label = env.label;
        existing.ctrl.description = env.description;
        continue;
      }
      this.controllers.set(env.id, { ctrl: this.createController(env), env });
    }
    await this.updateAffinities();
  }

  private createController(env: PyEnv): vscode.NotebookController {
    const id = 'dbx-local-' + env.id.replace(/[^\w.-]/g, '_').slice(-120);
    const ctrl = vscode.notebooks.createNotebookController(id, NOTEBOOK_TYPE, env.label);
    ctrl.description = env.description;
    ctrl.supportedLanguages = ['python', 'sql', 'shellscript', 'markdown', 'scala', 'r'];
    ctrl.supportsExecutionOrder = true;
    ctrl.executeHandler = (cells, nb) => this.execute(cells, nb, ctrl, () => this.controllers.get(env.id)?.env ?? env);
    ctrl.interruptHandler = (nb) => this.interrupt(nb);
    ctrl.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
      const s = this.sessions.get(notebook.uri.toString());
      if (!selected && s && s.python === env.python) this.disposeSession(notebook.uri.toString());
    });
    return ctrl;
  }

  private async updateAffinities() {
    for (const nb of vscode.workspace.notebookDocuments) if (nb.notebookType === NOTEBOOK_TYPE) await this.updateAffinity(nb);
  }

  private async updateAffinity(nb: vscode.NotebookDocument) {
    let preferredId: string | undefined;
    if (this.api) {
      try {
        const active = this.api.environments.getActiveEnvironmentPath(nb.uri);
        const resolved = active ? await this.api.environments.resolveEnvironment(active) : undefined;
        preferredId = resolved?.id ?? active?.id;
        if (preferredId && !this.controllers.has(preferredId)) {
          // match by path
          for (const [id, c] of this.controllers)
            if (c.env.python === (resolved?.executable?.uri?.fsPath ?? active?.path)) preferredId = id;
        }
      } catch {
        /* ignore */
      }
    }
    if (!preferredId && this.controllers.size === 1) preferredId = [...this.controllers.keys()][0];
    for (const [id, c] of this.controllers) {
      c.ctrl.updateNotebookAffinity(nb, id === preferredId ? vscode.NotebookControllerAffinity.Preferred : vscode.NotebookControllerAffinity.Default);
    }
  }

  private async getSession(nb: vscode.NotebookDocument, python: string): Promise<KernelSession> {
    const key = nb.uri.toString();
    let s = this.sessions.get(key);
    if (s && (s.dead || s.python !== python)) {
      this.disposeSession(key);
      s = undefined;
    }
    if (!s) {
      s = new KernelSession(python, nb.uri.scheme === 'untitled' ? '' : nb.uri.fsPath, this.context.extensionPath, this.log);
      const sess = s;
      s.onDeath = (msg) => {
        if (this.sessions.get(key) === sess) this.sessions.delete(key);
        vscode.window.showWarningMessage(`Databricks notebook kernel: ${msg} It will restart on the next run.`);
      };
      this.sessions.set(key, s);
    }
    try {
      await s.start();
    } catch (e) {
      this.sessions.delete(key);
      s.dispose();
      throw e;
    }
    return s;
  }

  private execute(cells: vscode.NotebookCell[], nb: vscode.NotebookDocument, ctrl: vscode.NotebookController, env: () => PyEnv) {
    const key = nb.uri.toString();
    const pend = this.pending.get(key) ?? new Set();
    this.pending.set(key, pend);
    const execs = cells.map((cell) => {
      const ex = ctrl.createNotebookCellExecution(cell);
      pend.add(ex);
      return ex;
    });
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (const ex of execs) {
        if (!pend.has(ex)) continue; // cancelled while queued
        pend.delete(ex);
        await this.runCell(ex, nb, env());
      }
    });
    this.queues.set(key, next.catch(() => undefined));
  }

  private async runCell(ex: vscode.NotebookCellExecution, nb: vscode.NotebookDocument, env: PyEnv) {
    const cell = ex.cell;
    ex.start(Date.now());
    await ex.clearOutput();
    const lang = cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : cell.document.languageId;
    const code = cell.document.getText();
    let session: KernelSession;
    const writerForErrors = new CellOutputWriter(ex, new Map());
    try {
      session = await this.getSession(nb, env.python);
    } catch (e: any) {
      writerForErrors.errorText('KernelStartupError', e?.message ?? String(e));
      await writerForErrors.flush();
      ex.end(false, Date.now());
      this.cancelPending(nb.uri.toString());
      if (e instanceof StartupError && e.missingDeps) this.offerInstall(env.python);
      return;
    }
    const writer = new CellOutputWriter(ex, session.displays);
    const tokenSub = ex.token.onCancellationRequested(() => session.interrupt());
    const done = await session.execute(code, lang, (t, c) => writer.handle(t, c));
    tokenSub.dispose();
    if (done.status === 'dead') writer.errorText('KernelDied', 'The kernel died while running this cell. It will restart on the next run.');
    await writer.flush();
    if (typeof done.execution_count === 'number') ex.executionOrder = done.execution_count;
    const ok = done.status === 'ok';
    ex.end(ok, Date.now());
    if (!ok) this.cancelPending(nb.uri.toString()); // like Jupyter: an error stops "Run All"
  }

  private cancelPending(key: string) {
    const pend = this.pending.get(key);
    if (!pend) return;
    for (const ex of pend) {
      ex.start();
      ex.end(undefined);
    }
    pend.clear();
  }

  interrupt(nb: vscode.NotebookDocument) {
    const key = nb.uri.toString();
    this.cancelPending(key);
    this.sessions.get(key)?.interrupt();
  }

  async restart(nb: vscode.NotebookDocument) {
    const key = nb.uri.toString();
    const s = this.sessions.get(key);
    this.cancelPending(key);
    this.disposeSession(key);
    if (s) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting kernel…' }, async () => {
        try {
          await this.getSession(nb, s.python);
        } catch (e: any) {
          vscode.window.showErrorMessage(e?.message ?? String(e));
        }
      });
    }
  }

  private offerInstall(python: string) {
    const btn = 'Install ipykernel';
    vscode.window
      .showErrorMessage(`The selected Python (${python}) needs ipykernel and jupyter_client to run cells.`, btn)
      .then((choice) => {
        if (choice !== btn) return;
        const term = vscode.window.createTerminal('Install ipykernel');
        term.show();
        const q = python.includes(' ') ? `"${python}"` : python;
        term.sendText(`${process.platform === 'win32' ? '& ' : ''}${q} -m pip install -U ipykernel jupyter_client`);
      });
  }

  private disposeSession(key: string) {
    const s = this.sessions.get(key);
    if (s) {
      s.onDeath = undefined;
      s.dispose();
    }
    this.sessions.delete(key);
    this.queues.delete(key);
  }

  dispose() {
    for (const k of [...this.sessions.keys()]) this.disposeSession(k);
    for (const c of this.controllers.values()) c.ctrl.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.log.dispose();
  }
}
