# Changelog

## 0.1.0

First release.

- Databricks source `.py` notebooks open in the notebook editor, and cells run on a local ipykernel. Outputs look the same as in Jupyter.
- `%md`, `%sql`, `%sh`, `%run`, `%pip` and `# DBTITLE` are supported. Saving round-trips the Databricks source format.
- `%sql` runs as `_sqldf = spark.sql(...)` + `display(_sqldf)`. A local `spark` session starts on first use (needs pyspark and Java 17+), or set the `databricksNotebook.spark` setting to `databricks-connect`.
- Includes a local `dbutils` stand-in (widgets, fs, secrets from env vars, notebook.run/exit).
