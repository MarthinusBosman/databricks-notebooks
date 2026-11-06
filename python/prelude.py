# Databricks-flavoured helpers injected into the local kernel (runs silently at start-up).
def __dbx_setup():
    import os
    import re
    import subprocess
    import sys
    from IPython import get_ipython
    from IPython.display import HTML, Markdown
    from IPython.display import display as _ipy_display

    import warnings
    # pyspark nags about pandas 3 on every first toPandas(); display() handles both fine.
    warnings.filterwarnings("ignore", message="PySpark does not yet fully support pandas")
    ip = get_ipython()
    ns = ip.user_ns

    HEADER = re.compile(r"^\s*#\s*databricks notebook source\s*$", re.I)
    SEP = re.compile(r"^# COMMAND -{5,}\s*$", re.M)
    MAGIC = re.compile(r"^# MAGIC ?")

    def _is_spark_df(obj):
        mod = type(obj).__module__ or ""
        return type(obj).__name__ == "DataFrame" and (mod.startswith("pyspark") or "spark" in mod)

    class _Dbx:
        nb_path = ""
        nb_dir = os.getcwd()
        display_limit = 1000

        # ---------------- start-up -----------------
        def init(self, nb_path, spark_mode):
            self.nb_path = nb_path or ""
            self.spark_mode = spark_mode or "auto"
            if nb_path:
                self.nb_dir = os.path.dirname(nb_path)
            ns.setdefault("__file__", nb_path)
            if spark_mode and spark_mode != "none" and "spark" not in ns:
                try:
                    if spark_mode == "databricks-connect":
                        from databricks.connect import DatabricksSession
                        ns["spark"] = DatabricksSession.builder.getOrCreate()
                        try:
                            from databricks.sdk import WorkspaceClient
                            ns["dbutils"] = WorkspaceClient().dbutils
                        except Exception:
                            pass
                    elif spark_mode == "local":
                        from pyspark.sql import SparkSession
                        ns["spark"] = SparkSession.builder.master("local[*]").appName("dbx-notebook").getOrCreate()
                except Exception as e:  # surfaced in the extension's output channel
                    print("spark init (%s) failed: %s" % (spark_mode, e))
            if self.spark_mode == "auto" and "spark" not in ns:
                ns["spark"] = _LazySpark()
            ns.setdefault("dbutils", _DbUtils())
            if "spark" in ns and "sc" not in ns and not isinstance(ns["spark"], _LazySpark):
                try:
                    ns["sc"] = ns["spark"].sparkContext
                except Exception:
                    pass

        # ---------------- display -----------------
        def display(self, *objs, **kw):
            __tracebackhide__ = True  # noqa: F841
            for obj in objs:
                if _is_spark_df(obj):
                    if not len(obj.columns):  # e.g. result of CREATE / INSERT
                        continue
                    import warnings
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore")
                        pdf = obj.limit(self.display_limit).toPandas()
                    _ipy_display(pdf)
                else:
                    _ipy_display(obj, **kw)

        def show_markdown(self, text):
            _ipy_display(Markdown(text))

        # ---------------- %sql -----------------
        spark_mode = "auto"

        def make_local_spark(self):
            __tracebackhide__ = True  # noqa: F841 (IPython hides this frame)
            try:
                import pyspark
                from pyspark.sql import SparkSession
            except ImportError:
                raise RuntimeError(
                    "There is no `spark` session. `pip install pyspark` (needs Java 17+) for an automatic local "
                    "session, set 'databricksNotebook.spark' to 'databricks-connect', or create `spark` yourself."
                ) from None
            sys.stderr.write("Starting a local Spark session (pyspark %s)...\n" % pyspark.__version__)
            sys.stderr.flush()
            # The JVM inherits fds 1/2 when it starts; point them at devnull meanwhile so its log4j
            # start-up chatter doesn't land in the cell output (errors still arrive as Python exceptions).
            saved = []
            try:
                sys.stdout.flush()
                sys.stderr.flush()
                devnull = os.open(os.devnull, os.O_WRONLY)
                for fd in (1, 2):
                    saved.append((fd, os.dup(fd)))
                    os.dup2(devnull, fd)
                os.close(devnull)
            except OSError:
                pass
            try:
                spark = (SparkSession.builder.master("local[*]").appName("dbx-notebook")
                         .config("spark.ui.showConsoleProgress", "false").getOrCreate())
            except Exception as e:
                hint = ""
                if "JAVA_GATEWAY" in str(e) or "JAVA_HOME" in str(e):
                    hint = " Local Spark needs Java 17+ installed (set JAVA_HOME or put java on PATH)."
                raise RuntimeError("Couldn't start a local Spark session: %s.%s" % (str(e).rstrip("."), hint)) from None
            finally:
                for fd, dup in saved:
                    os.dup2(dup, fd)
                    os.close(dup)
            spark.sparkContext.setLogLevel("ERROR")
            try:
                import pyarrow  # noqa: F401
            except ImportError:  # avoid pyspark's arrow fallback warnings on every display()
                spark.conf.set("spark.sql.execution.arrow.pyspark.enabled", "false")
            return spark

        # ---------------- %sh -----------------
        def run_sh(self, script):
            if os.name == "nt":
                cmd = ["powershell", "-NoProfile", "-Command", script]
            else:
                cmd = ["/bin/bash", "-c", script]
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=self.nb_dir,
                                 text=True, bufsize=1)
            for line in p.stdout:
                sys.stdout.write(line)
                sys.stdout.flush()
            rc = p.wait()
            if rc:
                raise subprocess.CalledProcessError(rc, "%sh")

        # ---------------- %fs -----------------
        def run_fs(self, args):
            parts = args.split()
            if not parts:
                raise ValueError("usage: %fs ls <path>")
            op, rest = parts[0], parts[1:]
            fn = getattr(ns["dbutils"].fs, op, None)
            if fn is None:
                raise NotImplementedError("%fs " + op)
            res = fn(*rest)
            if isinstance(res, list):
                try:
                    import pandas as pd
                    _ipy_display(pd.DataFrame([getattr(r, "_asdict", lambda: r)() if hasattr(r, "_asdict") else r for r in res]))
                    return
                except Exception:
                    pass
            if res is not None:
                _ipy_display(res)

        # ---------------- %run -----------------
        def run_notebook(self, target):
            target = target.strip().strip('"').strip("'")
            path = target if os.path.isabs(target) else os.path.normpath(os.path.join(self.nb_dir, target))
            if not os.path.exists(path) and os.path.exists(path + ".py"):
                path = path + ".py"
            if not os.path.exists(path):
                raise FileNotFoundError("%run: notebook not found: " + path)
            with open(path, encoding="utf-8") as f:
                src = f.read().replace("\r\n", "\n")
            lines = src.split("\n")
            if lines and HEADER.match(lines[0]):
                lines = lines[1:]
            prev_dir = self.nb_dir
            self.nb_dir = os.path.dirname(path)
            try:
                for chunk in SEP.split("\n".join(lines)):
                    cl = [l for l in chunk.strip("\n").split("\n")]
                    if cl and cl[0].startswith("# DBTITLE"):
                        cl = cl[1:]
                    nonempty = [l for l in cl if l.strip()]
                    if not nonempty:
                        continue
                    if all(l.startswith("# MAGIC") for l in nonempty):
                        body = "\n".join(MAGIC.sub("", l, count=1) for l in cl)
                        head = body.lstrip().split("\n", 1)[0].strip().lower()
                        if head.startswith("%md"):
                            continue
                        code = _translate(body, "python")
                    else:
                        code = "\n".join(cl)
                    r = ip.run_cell(code, store_history=False)
                    if not r.success:
                        raise RuntimeError("%run " + target + " failed")
            finally:
                self.nb_dir = prev_dir

    class _LazySpark:
        """`spark` placeholder: starts a local session the first time it's used (like Databricks, where
        `spark` always exists), then replaces itself in the namespace."""
        _real = None

        def _get(self):
            __tracebackhide__ = True  # noqa: F841
            if _LazySpark._real is None:
                _LazySpark._real = ns["__dbx__"].make_local_spark()
                if ns.get("spark") is self:
                    ns["spark"] = _LazySpark._real
                ns.setdefault("sc", _LazySpark._real.sparkContext)
            return _LazySpark._real

        def __getattr__(self, name):
            __tracebackhide__ = True  # noqa: F841
            if name.startswith("__"):
                raise AttributeError(name)
            return getattr(self._get(), name)

        def __repr__(self):
            return "<spark: a local session starts on first use>" if _LazySpark._real is None else repr(_LazySpark._real)

    def _translate(code, language):
        first, _, rest = code.lstrip("\n").partition("\n")
        f = first.strip()
        if f.startswith("%"):
            magic, _, arg = f[1:].partition(" ")
            magic = magic.lower()
            body = (arg + "\n" + rest) if arg.strip() else rest
            if magic == "run":
                return "__dbx__.run_notebook(%r)" % arg.strip()
            if magic == "sql":
                return _dbx_sql_to_source(body)
            if magic == "sh":
                return "__dbx__.run_sh(%r)" % body
            if magic == "python":
                return body
        return code

    # ------------------------------------------------------------------
    # Minimal local dbutils stand-in (widgets, fs on local disk, secrets via env)
    # ------------------------------------------------------------------
    class _FileInfo(tuple):
        __slots__ = ()
        _fields = ("path", "name", "size", "modificationTime")

        def __new__(cls, path, name, size, mtime):
            return tuple.__new__(cls, (path, name, size, mtime))

        path = property(lambda s: s[0])
        name = property(lambda s: s[1])
        size = property(lambda s: s[2])
        modificationTime = property(lambda s: s[3])

        def _asdict(self):
            return dict(zip(self._fields, self))

        def __repr__(self):
            return "FileInfo(path=%r, name=%r, size=%r, modificationTime=%r)" % tuple(self)

    def _local(p):
        for pre in ("dbfs:", "file:"):
            if p.startswith(pre):
                p = p[len(pre):]
        return p

    class _Fs:
        def ls(self, path="."):
            p = _local(path)
            res = []
            for n in sorted(os.listdir(p)):
                fp = os.path.join(p, n)
                st = os.stat(fp)
                isdir = os.path.isdir(fp)
                res.append(_FileInfo(fp + ("/" if isdir else ""), n + ("/" if isdir else ""),
                                     0 if isdir else st.st_size, int(st.st_mtime * 1000)))
            return res

        def head(self, path, maxBytes=65536):
            with open(_local(path), "r", encoding="utf-8", errors="replace") as f:
                return f.read(maxBytes)

        def put(self, path, contents, overwrite=False):
            p = _local(path)
            if os.path.exists(p) and not overwrite:
                raise FileExistsError(p)
            with open(p, "w", encoding="utf-8") as f:
                f.write(contents)
            return True

        def mkdirs(self, path):
            os.makedirs(_local(path), exist_ok=True)
            return True

        def rm(self, path, recurse=False):
            import shutil
            p = _local(path)
            if os.path.isdir(p):
                (shutil.rmtree if recurse else os.rmdir)(p)
            elif os.path.exists(p):
                os.remove(p)
            return True

        def cp(self, src, dst, recurse=False):
            import shutil
            s, d = _local(src), _local(dst)
            (shutil.copytree if os.path.isdir(s) else shutil.copy2)(s, d)
            return True

        def mv(self, src, dst, recurse=False):
            import shutil
            shutil.move(_local(src), _local(dst))
            return True

    class _Widgets:
        def __init__(self):
            self._v = {}

        def _def(self, name, defaultValue, *a, **k):
            self._v.setdefault(name, defaultValue)

        text = dropdown = combobox = _def

        def multiselect(self, name, defaultValue, *a, **k):
            self._v.setdefault(name, defaultValue)

        def get(self, name):
            if name not in self._v:
                raise KeyError("No widget named %r (local dbutils stub)" % name)
            return self._v[name]

        getArgument = get

        def getAll(self):
            return dict(self._v)

        def remove(self, name):
            self._v.pop(name, None)

        def removeAll(self):
            self._v.clear()

    class _Secrets:
        def get(self, scope, key):
            env = "DBX_SECRET_%s_%s" % (re.sub(r"\W", "_", scope).upper(), re.sub(r"\W", "_", key).upper())
            if env in os.environ:
                return os.environ[env]
            raise KeyError("Secret %s/%s not available locally - set env var %s" % (scope, key, env))

        def list(self, scope):
            return []

        def listScopes(self):
            return []

    class _NotebookExit(Exception):
        pass

    class _Notebook:
        def exit(self, value=""):
            print("Notebook exited: %s" % value)
            raise _NotebookExit(value)

        def run(self, path, timeout_seconds=0, arguments=None):
            ns["__dbx__"].run_notebook(path)

    class _DbUtils:
        def __init__(self):
            self.fs = _Fs()
            self.widgets = _Widgets()
            self.secrets = _Secrets()
            self.notebook = _Notebook()

        def __repr__(self):
            return "<local dbutils stub: fs, widgets, secrets, notebook>"

    dbx = _Dbx()
    ns["__dbx__"] = dbx
    ns.setdefault("display", dbx.display)
    ns.setdefault("displayHTML", lambda html: _ipy_display(HTML(html)))
    # keep these out of %who / the variable list
    ip.user_ns_hidden.update({k: ns[k] for k in ("__dbx__", "display", "displayHTML")})


__dbx_setup()
del __dbx_setup
