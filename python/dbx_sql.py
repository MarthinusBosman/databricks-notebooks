# Shared by driver.py (to translate %sql cells) and the kernel prelude (for %run).
# Kept free of imports so it can be exec'd inside the kernel as-is.


def _dbx_split_sql(q):
    """Split a SQL script on ';' outside quotes, dropping -- comments."""
    out, cur, quote = [], [], None
    i = 0
    while i < len(q):
        ch = q[i]
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            cur.append(ch)
        elif ch == "-" and q[i:i + 2] == "--":
            j = q.find("\n", i)
            i = len(q) if j < 0 else j
            continue
        elif ch == ";":
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    out.append("".join(cur))
    return [s.strip() for s in out if s.strip()]


def _dbx_sql_to_source(query):
    """%sql cell -> the Python that runs it, the way Databricks does:
    every statement becomes `_sqldf = spark.sql(...)`, then the last result is displayed."""
    stmts = _dbx_split_sql(query)
    if not stmts:
        return "pass"
    lines = []
    for s in stmts:
        lit = '"""' + s.replace("\\", "\\\\").replace('"""', '\\"\\"\\"') + '"""' if "\n" in s and not s.endswith('"') else repr(s)
        lines.append("_sqldf = spark.sql(%s)" % lit)
    lines.append("display(_sqldf)")
    return "\n".join(lines)
