"""Drive python/driver.py over its JSON protocol and check the outputs.
Usage: <python-with-ipykernel> test/driver_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp()
helper = os.path.join(tmp, "helpers.py")
with open(helper, "w") as f:
    f.write("# Databricks notebook source\nHELPER = 42\n\n# COMMAND ----------\n\n# MAGIC %md\n# MAGIC skip me\n\n"
            "# COMMAND ----------\n\ndef twice(x):\n    return 2 * x\n")
nb = os.path.join(tmp, "main.py")
open(nb, "w").write("# Databricks notebook source\n")

env = dict(os.environ, DBX_NOTEBOOK_PATH=nb, DBX_NOTEBOOK_CWD=tmp, DBX_STARTUP_CODE="STARTUP_RAN = True",
           DBX_SECRET_MYSCOPE_TOKEN="s3cret")
p = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "python", "driver.py")], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=tmp)
msgs = []
cond = threading.Condition()


def reader():
    for line in p.stdout:
        with cond:
            msgs.append(json.loads(line))
            cond.notify_all()


threading.Thread(target=reader, daemon=True).start()
threading.Thread(target=lambda: [sys.stderr.write("  [stderr] " + l) for l in p.stderr], daemon=True).start()


def wait_for(pred, timeout=60):
    end = time.time() + timeout
    with cond:
        while time.time() < end:
            for m in msgs:
                if pred(m):
                    return m
            cond.wait(0.5)
    raise TimeoutError("timed out; msgs=%s" % msgs[-5:])


ready = wait_for(lambda m: m["type"] in ("ready", "startup_error"))
assert ready["type"] == "ready", ready
n = [0]


def run(code, language="python", timeout=60):
    n[0] += 1
    rid = "t%d" % n[0]
    p.stdin.write(json.dumps({"cmd": "execute", "id": rid, "code": code, "language": language}) + "\n")
    p.stdin.flush()
    done = wait_for(lambda m: m.get("id") == rid and m["type"] == "done", timeout)
    outs = [m for m in msgs if m.get("id") == rid and m["type"] == "output" and m["msg_type"] != "execute_input"]
    return done, outs


failures = 0


def check(name, cond_, detail=""):
    global failures
    print(("ok   " if cond_ else "FAIL ") + name + ("" if cond_ else "  -> %s" % detail))
    if not cond_:
        failures += 1


d, o = run("print('hello')\n1+1")
check("stream + execute_result", d["status"] == "ok" and o[0]["content"]["text"] == "hello\n"
      and o[1]["msg_type"] == "execute_result" and o[1]["content"]["data"]["text/plain"] == "2", o)
check("execution count", d["execution_count"] == 1, d)

d, o = run("STARTUP_RAN, __file__")
check("startup code + __file__", "True" in o[0]["content"]["data"]["text/plain"] and "main.py" in o[0]["content"]["data"]["text/plain"], o)

d, o = run("import pandas as pd\npd.DataFrame({'a':[1,2]})")
check("pandas html", "text/html" in o[0]["content"]["data"], o)

d, o = run("display(pd.DataFrame({'a':[1]}))")
check("display() -> display_data", o and o[0]["msg_type"] == "display_data" and "text/html" in o[0]["content"]["data"], o)

d, o = run("%matplotlib inline\nimport matplotlib.pyplot as plt\nplt.plot([1,2,3]); plt.show()", timeout=120)
check("matplotlib png", any("image/png" in m["content"].get("data", {}) for m in o), [m["msg_type"] for m in o])

d, o = run("1/0")
check("error", d["status"] == "error" and o[-1]["msg_type"] == "error" and o[-1]["content"]["ename"] == "ZeroDivisionError", o)

d, o = run("echo from-shell; pwd", "shellscript")
check("%sh cell", d["status"] == "ok" and "from-shell" in "".join(m["content"].get("text", "") for m in o), o)

d, o = run("%sh echo inline-sh")
check("%sh magic in python cell", "inline-sh" in "".join(m["content"].get("text", "") for m in o), o)

d, o = run("%run ./helpers")
d2, o2 = run("HELPER, twice(4)")
check("%run", d["status"] == "ok" and "(42, 8)" in o2[0]["content"]["data"]["text/plain"], (o, o2))

try:
    import pyspark  # noqa: F401
    HAVE_SPARK = bool(os.environ.get("JAVA_HOME"))
except ImportError:
    HAVE_SPARK = False
if HAVE_SPARK:
    d, o = run("select 1 as a, 'x' as b", "sql", timeout=180)
    html = [m for m in o if m["msg_type"] == "display_data" and "text/html" in m["content"]["data"]]
    check("%sql -> auto local spark + display(_sqldf) as table", d["status"] == "ok" and html and "<table" in html[0]["content"]["data"]["text/html"], o)
    noise = [m["content"].get("text", "") for m in o if m["msg_type"] == "stream"]
    check("spark start-up is quiet (one info line)", len("".join(noise).strip().splitlines()) <= 1, noise)
    d, o = run("-- comment; with semicolon\ncreate or replace temp view v as select 2 as n;\nselect n * 10 as m from v", "sql", timeout=120)
    html = [m for m in o if m["msg_type"] == "display_data"]
    check("%sql multi-statement shows last result", d["status"] == "ok" and len(html) == 1 and "20" in html[0]["content"]["data"]["text/html"], o)
    d, o = run("type(_sqldf).__name__, _sqldf.collect()[0].m")
    check("_sqldf is the spark DataFrame", "('DataFrame', 20)" in o[0]["content"]["data"]["text/plain"], o)
    d, o = run("%sql select 'inline' as s")
    check("%sql magic typed in python cell", d["status"] == "ok" and any(m["msg_type"] == "display_data" for m in o), o)
    d, o = run("create temp view v2 as select 1 as z", "sql")
    check("DDL shows no table", d["status"] == "ok" and not [m for m in o if m["msg_type"] == "display_data"], o)
    d, o = run("select * from no_such_table", "sql")
    check("bad SQL -> error output", d["status"] == "error" and o[-1]["msg_type"] == "error", o[-1:])
    import re
    tb = re.sub(r"\x1b\[[0-9;]*m", "", "\n".join(o[-1]["content"]["traceback"]))
    check("bad SQL traceback shows the SQL line, not helper internals", "----> 1 _sqldf = spark.sql('select * from no_such_table')" in tb and "__dbx__" not in tb and "_LazySpark" not in tb, tb)
    if os.environ.get("SHOW_TB"):
        import re
        print(re.sub(r"\x1b\[[0-9;]*m", "", tb))
    d, o = run("type(spark).__name__")
    check("spark replaced by the real session", "'SparkSession'" in o[0]["content"]["data"]["text/plain"], o)
else:
    d, o = run("select 1", "sql")
    check("%sql without spark -> clear error", d["status"] == "error" and ("pip install pyspark" in o[-1]["content"]["evalue"] or "Java 17+" in o[-1]["content"]["evalue"]), o[-1:])
    tb = "\n".join(o[-1]["content"]["traceback"])
    import re as _re
    tb = _re.sub(r"\x1b\[[0-9;]*m", "", tb)
    check("no-spark error is short", len(tb) < 1500 and "java_gateway" not in tb, tb)

d, o = run("# Title\nsome *md*", "markdown")
check("markdown via kernel", "text/markdown" in o[0]["content"]["data"], o)

d, o = run("dbutils.widgets.text('x','7'); print(dbutils.widgets.get('x'), dbutils.secrets.get('myscope','token'))")
check("dbutils stub", "7 s3cret" in o[0]["content"]["text"], o)

d, o = run("from IPython.display import display\nh = display('a', display_id=True)\nh.update('b')")
check("update_display_data", any(m["msg_type"] == "update_display_data" for m in o), [m["msg_type"] for m in o])

# interrupt
n[0] += 1
rid = "t%d" % n[0]
p.stdin.write(json.dumps({"cmd": "execute", "id": rid, "code": "import time\nfor i in range(100): time.sleep(0.1)", "language": "python"}) + "\n")
p.stdin.flush()
time.sleep(1.5)
p.stdin.write(json.dumps({"cmd": "interrupt"}) + "\n")
p.stdin.flush()
d = wait_for(lambda m: m.get("id") == rid and m["type"] == "done", 20)
o = [m for m in msgs if m.get("id") == rid and m["msg_type" if "msg_type" in m else "type"] == "error"]
check("interrupt -> KeyboardInterrupt", d["status"] == "error" and o and o[0]["content"]["ename"] == "KeyboardInterrupt", (d, o))

d, o = run("print('still alive')")
check("kernel alive after interrupt", o[0]["content"]["text"] == "still alive\n", o)

p.stdin.write(json.dumps({"cmd": "shutdown"}) + "\n")
p.stdin.flush()
p.wait(timeout=20)
check("clean shutdown", p.returncode == 0, p.returncode)
print("%d failures" % failures)
sys.exit(1 if failures else 0)
