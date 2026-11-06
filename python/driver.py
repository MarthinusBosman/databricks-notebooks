"""Bridge between the VS Code extension and a local IPython (Jupyter) kernel.

Protocol: newline-delimited JSON.
  stdin  (from extension): {"cmd": "execute", "id": str, "code": str, "language": str}
                           {"cmd": "interrupt"} | {"cmd": "shutdown"}
  stdout (to extension):   {"type": "ready", ...} | {"type": "startup_error", "message": str}
                           {"type": "output", "id": str, "msg_type": str, "content": {...}}
                           {"type": "done", "id": str, "status": str, "execution_count": int|None}
                           {"type": "dead", "message": str} | {"type": "log", "message": str}

The kernel is a real ipykernel started with *this* interpreter, so outputs (rich
reprs, matplotlib inline, tracebacks, ...) are byte-for-byte what Jupyter produces.
"""
import json
import os
import queue
import sys
import threading
import traceback

# Keep the protocol channel private: anything else that writes to fd 1 (C libs,
# child processes) gets redirected to stderr so it can't corrupt the JSON stream.
_proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
_lock = threading.Lock()

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from dbx_sql import _dbx_sql_to_source  # noqa: E402


def send(obj):
    line = json.dumps(obj, default=str)
    with _lock:
        _proto.write(line + "\n")
        _proto.flush()


def log(msg):
    send({"type": "log", "message": str(msg)})


# --------------------------------------------------------------------------
# Cell translation (Databricks magics -> Python run in the kernel)
# --------------------------------------------------------------------------
LANG_MAGICS = {"sql": "sql", "sh": "shellscript", "md": "markdown", "md-sandbox": "markdown",
               "python": "python", "scala": "scala", "r": "r", "fs": "fs", "run": "run"}


def translate(code, language):
    """Return python source to run in the kernel for a cell."""
    language = (language or "python").lower()
    stripped = code.lstrip("\n")
    first, _, rest = stripped.partition("\n")
    first_s = first.strip()
    # A python cell may still start with a Databricks language magic typed by the user.
    if language == "python" and first_s.startswith("%") and not first_s.startswith("%%"):
        magic, _, arg = first_s[1:].partition(" ")
        magic = magic.lower()
        if magic == "run":
            return "__dbx__.run_notebook(%r)" % arg.strip()
        if magic in ("sql", "sh", "md", "md-sandbox", "scala", "r", "fs"):
            language = LANG_MAGICS[magic]
            code = (arg + "\n" + rest) if arg.strip() else rest
        elif magic == "python":
            code = (arg + "\n" + rest) if arg.strip() else rest
    if language == "python":
        return code
    if language == "sql":
        return _dbx_sql_to_source(code)
    if language in ("shellscript", "sh", "bash", "shell"):
        return "__dbx__.run_sh(%r)" % code
    if language == "markdown":
        return "__dbx__.show_markdown(%r)" % code
    if language == "fs":
        return "__dbx__.run_fs(%r)" % code.strip()
    return "raise NotImplementedError(%r)" % (
        "%s cells can't run locally - only Python, SQL (needs a spark session) and %%sh are supported." % language)


# --------------------------------------------------------------------------
# Kernel management
# --------------------------------------------------------------------------
def start_kernel(cwd, extra_env):
    from jupyter_client.kernelspec import KernelSpec
    from jupyter_client.manager import KernelManager

    spec = KernelSpec(
        argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name="Python (Databricks local)",
        language="python",
        env={},
    )

    class _KM(KernelManager):
        @property
        def kernel_spec(self):
            return spec

    km = _KM()
    env = os.environ.copy()
    env.update(extra_env or {})
    env.setdefault("PYDEVD_DISABLE_FILE_VALIDATION", "1")
    import subprocess
    km.start_kernel(cwd=cwd or None, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=90)
    return km, kc


class Runner:
    def __init__(self, km, kc):
        self.km = km
        self.kc = kc
        self.q = queue.Queue()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def submit(self, req):
        self.q.put(req)

    def _loop(self):
        while True:
            req = self.q.get()
            if req is None:
                return
            try:
                self._run(req)
            except Exception as e:  # never kill the worker
                send({"type": "output", "id": req.get("id"), "msg_type": "error",
                      "content": {"ename": type(e).__name__, "evalue": str(e),
                                  "traceback": traceback.format_exc().splitlines()}})
                send({"type": "done", "id": req.get("id"), "status": "error", "execution_count": None})

    def _run(self, req):
        rid = req.get("id")
        silent = bool(req.get("silent"))
        code = req["code"] if req.get("raw") else translate(req["code"], req.get("language"))
        msg_id = self.kc.execute(code, silent=silent, store_history=not silent, allow_stdin=False)
        idle = False
        while not idle:
            try:
                msg = self.kc.get_iopub_msg(timeout=0.5)
            except queue.Empty:
                if not self.km.is_alive():
                    send({"type": "dead", "message": "The kernel died unexpectedly."})
                    send({"type": "done", "id": rid, "status": "dead", "execution_count": None})
                    return
                continue
            if msg.get("parent_header", {}).get("msg_id") != msg_id:
                continue
            mt = msg["msg_type"]
            content = msg["content"]
            if mt == "status":
                idle = content.get("execution_state") == "idle"
                continue
            if silent:
                if mt == "error":
                    log("startup code error: %s: %s" % (content.get("ename"), content.get("evalue")))
                elif mt == "stream":
                    log(content.get("text", "").rstrip())
                continue
            if mt in ("stream", "display_data", "execute_result", "error", "clear_output",
                      "update_display_data", "execute_input"):
                send({"type": "output", "id": rid, "msg_type": mt, "content": content})
        # matching shell reply
        status, count = "ok", None
        while True:
            try:
                reply = self.kc.get_shell_msg(timeout=30)
            except queue.Empty:
                break
            if reply.get("parent_header", {}).get("msg_id") == msg_id:
                status = reply["content"].get("status", "ok")
                count = reply["content"].get("execution_count")
                break
        send({"type": "done", "id": rid, "status": status, "execution_count": count})


def main():
    cwd = os.environ.get("DBX_NOTEBOOK_CWD") or os.getcwd()
    try:
        import jupyter_client  # noqa: F401
        import ipykernel  # noqa: F401
    except ImportError as e:
        send({"type": "startup_error", "missing": True,
              "message": "%s. Install with: %s -m pip install ipykernel jupyter_client" % (e, sys.executable)})
        return 2
    try:
        km, kc = start_kernel(cwd, {})
    except Exception as e:
        send({"type": "startup_error", "message": "Could not start kernel: %s" % e})
        return 3

    runner = Runner(km, kc)
    # Databricks-flavoured helpers (display, dbutils stub, %run, %sql ...)
    prelude = ""
    for name in ("dbx_sql.py", "prelude.py"):
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            prelude += f.read() + "\n"
    runner.submit({"id": "__prelude__", "raw": True, "silent": True, "code": prelude})
    nb_path = os.environ.get("DBX_NOTEBOOK_PATH", "")
    spark_mode = os.environ.get("DBX_SPARK_MODE", "auto")
    runner.submit({"id": "__init__", "raw": True, "silent": True,
                   "code": "__dbx__.init(%r, %r)" % (nb_path, spark_mode)})
    startup = os.environ.get("DBX_STARTUP_CODE", "")
    if startup.strip():
        runner.submit({"id": "__startup__", "raw": True, "silent": True, "code": startup})
    send({"type": "ready", "python": sys.executable, "version": sys.version.split()[0]})

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
            except ValueError:
                log("bad command: %r" % line)
                continue
            c = cmd.get("cmd")
            if c == "execute":
                runner.submit(cmd)
            elif c == "interrupt":
                try:
                    km.interrupt_kernel()
                except Exception as e:
                    log("interrupt failed: %s" % e)
            elif c == "shutdown":
                break
    finally:
        try:
            kc.stop_channels()
            km.shutdown_kernel(now=True)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
