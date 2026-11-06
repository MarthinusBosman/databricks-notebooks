// Plain-node unit tests for the Databricks source-format parser.
const assert = require('assert');
const { parse, serialize, isDatabricksNotebook } = require('../../out/parser');

let n = 0;
function test(name, fn) {
  try {
    fn();
    n++;
    console.log('ok   ' + name);
  } catch (e) {
    console.error('FAIL ' + name + '\n' + e.stack);
    process.exitCode = 1;
  }
}

const SAMPLE = `# Databricks notebook source
# MAGIC %md
# MAGIC # Title
# MAGIC
# MAGIC Some *text*

# COMMAND ----------

import pandas as pd
df = pd.DataFrame({"a": [1, 2]})
df

# COMMAND ----------

# DBTITLE 1,Query things
# MAGIC %sql
# MAGIC SELECT *
# MAGIC FROM t

# COMMAND ----------

# MAGIC %pip install requests

# COMMAND ----------

# MAGIC %run ./helpers

# COMMAND ----------

# MAGIC %sh ls -la

# COMMAND ----------

# MAGIC %md-sandbox
# MAGIC <b>hi</b>

# COMMAND ----------

# MAGIC %python
# MAGIC print(1)

# COMMAND ----------

print("last")
`;

test('detects header', () => {
  assert.ok(isDatabricksNotebook(SAMPLE));
  assert.ok(isDatabricksNotebook('\uFEFF# Databricks notebook source\r\nx=1'));
  assert.ok(!isDatabricksNotebook('import os\n# Databricks notebook source'));
});

test('parses cells', () => {
  const nb = parse(SAMPLE);
  const summary = nb.cells.map((c) => [c.kind, c.language, c.source]);
  assert.deepStrictEqual(summary, [
    ['markdown', 'markdown', '# Title\n\nSome *text*'],
    ['code', 'python', 'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2]})\ndf'],
    ['code', 'sql', 'SELECT *\nFROM t'],
    ['code', 'python', '%pip install requests'],
    ['code', 'python', '%run ./helpers'],
    ['code', 'shellscript', 'ls -la'],
    ['markdown', 'markdown', '<b>hi</b>'],
    ['code', 'python', 'print(1)'],
    ['code', 'python', 'print("last")'],
  ]);
  assert.strictEqual(nb.cells[2].meta.title, 'Query things');
  assert.strictEqual(nb.cells[6].meta.magic, 'md-sandbox');
});

test('round-trips canonical file byte-for-byte (except one-line %sh normalisation)', () => {
  const expected = SAMPLE.replace('# MAGIC %sh ls -la', '# MAGIC %sh\n# MAGIC ls -la');
  assert.strictEqual(serialize(parse(SAMPLE)), expected);
  assert.strictEqual(serialize(parse(expected)), expected);
});

test('round-trips CRLF and no trailing newline', () => {
  const s = '# Databricks notebook source\r\nx = 1\r\n\r\n# COMMAND ----------\r\n\r\n# MAGIC %md\r\n# MAGIC hi';
  const nb = parse(s);
  assert.strictEqual(nb.eol, '\r\n');
  assert.strictEqual(nb.cells.length, 2);
  assert.strictEqual(serialize(nb), s);
});

test('header-only file -> zero cells', () => {
  assert.strictEqual(parse('# Databricks notebook source\n').cells.length, 0);
});

test('new cells serialize with magics', () => {
  const out = serialize({
    eol: '\n',
    trailingNewline: true,
    cells: [
      { kind: 'markdown', language: 'markdown', source: '## Hi', meta: {} },
      { kind: 'code', language: 'sql', source: 'select 1', meta: {} },
      { kind: 'code', language: 'python', source: '%pip install x\n', meta: {} },
      { kind: 'code', language: 'python', source: '%%timeit\nx=1', meta: {} },
      { kind: 'code', language: 'python', source: '', meta: {} },
    ],
  });
  assert.strictEqual(
    out,
    '# Databricks notebook source\n# MAGIC %md\n# MAGIC ## Hi\n\n# COMMAND ----------\n\n# MAGIC %sql\n# MAGIC select 1\n\n# COMMAND ----------\n\n# MAGIC %pip install x\n\n# COMMAND ----------\n\n%%timeit\nx=1\n\n# COMMAND ----------\n\n'
  );
  // and it parses back to the same cells
  const back = parse(out).cells.map((c) => [c.language, c.source]);
  assert.deepStrictEqual(back, [
    ['markdown', '## Hi'],
    ['sql', 'select 1'],
    ['python', '%pip install x'],
    ['python', '%%timeit\nx=1'],
    ['python', ''],
  ]);
});

test('python comments that look like magic but mixed with code stay python', () => {
  const nb = parse('# Databricks notebook source\n# MAGIC %md\nx = 1\n');
  assert.strictEqual(nb.cells[0].language, 'python');
  assert.strictEqual(nb.cells[0].source, '# MAGIC %md\nx = 1');
});

console.log(`${n} tests passed`);
