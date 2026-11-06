# Databricks notebook source
# MAGIC %md
# MAGIC # Sample notebook
# MAGIC This is **markdown**.

# COMMAND ----------

# MAGIC %run ./helpers

# COMMAND ----------

import pandas as pd
print("helper says", HELPER)
pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]})

# COMMAND ----------

# DBTITLE 1,A plot
# MAGIC %matplotlib inline

# COMMAND ----------

import matplotlib.pyplot as plt
plt.plot([1, 4, 9])
plt.show()

# COMMAND ----------

# MAGIC %sh
# MAGIC echo "hello from sh"

# COMMAND ----------

import time
for i in range(3):
    print(f"\rprogress {i}", end="")
    time.sleep(0.05)
print()

# COMMAND ----------

raise ValueError("boom")
