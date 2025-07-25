/* globals bootstrap */
import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { markedHighlight } from "https://cdn.jsdelivr.net/npm/marked-highlight@2/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";
import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4/+esm";
import { openaiConfig } from "https://cdn.jsdelivr.net/npm/bootstrap-llm-provider@1.1";

// Initialize SQLite
const defaultDB = "@";
const sqlite3 = await sqlite3InitModule({ printErr: console.error });

// Initialize ChartJS
Chart.register(...registerables);

// Set up DOM elements
const $demos = document.querySelector("#demos");
const $upload = document.getElementById("upload");
const $tablesContainer = document.getElementById("tables-container");
const $sql = document.getElementById("sql");
const $toast = document.getElementById("toast");
const $result = document.getElementById("result");
const $chartCode = document.getElementById("chart-code");
const toast = new bootstrap.Toast($toast);
const loading = html`<div class="spinner-border" role="status">
  <span class="visually-hidden">Loading...</span>
</div>`;

let latestQueryResult = [];
let latestChart;

// --------------------------------------------------------------------
// Set up Markdown
const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
  },
});

render(
  html`
    <div class="mb-3">
      <label for="file" class="form-label">Upload CSV (<code>.csv</code>) or SQLite databases (<code>.sqlite3</code>, <code>.db</code>)</label>
      <input class="form-control" type="file" id="file" name="file" accept=".csv,.sqlite3,.db,.sqlite,.s3db,.sl3" multiple />
    </div>
  `,
  $upload,
);

// --------------------------------------------------------------------
// Render demos

fetch("config.json")
  .then((r) => r.json())
  .then(({ demos }) => {
    $demos.innerHTML = "";
    render(
      demos.map(
        ({ title, body, file, context, questions }) =>
          html` <div class="col py-3">
            <a
              class="demo card h-100 text-decoration-none"
              href="${file}"
              data-questions=${JSON.stringify(questions ?? [])}
              data-context=${JSON.stringify(context ?? "")}
            >
              <div class="card-body">
                <h5 class="card-title">${title}</h5>
                <p class="card-text">${body}</p>
              </div>
            </a>
          </div>`,
      ),
      $demos,
    );
  });

$demos.addEventListener("click", async (e) => {
  const $demo = e.target.closest(".demo");
  if ($demo) {
    e.preventDefault();
    const file = $demo.getAttribute("href");
    render(html`<div class="text-center my-3">${loading}</div>`, $tablesContainer);
    await DB.upload(new File([await fetch(file).then((r) => r.blob())], file.split("/").pop()));
    const questions = JSON.parse($demo.dataset.questions);
    if (questions.length) {
      DB.questionInfo.schema = JSON.stringify(DB.schema());
      DB.questionInfo.questions = questions;
    }
    DB.context = JSON.parse($demo.dataset.context);
    drawTables();
  }
});

// --------------------------------------------------------------------
// Manage database tables
const db = new sqlite3.oo1.DB(defaultDB, "c");
const DB = {
  context: "",

  schema: function () {
    let tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, { rowMode: "object" });
      tables.push(table);
    });
    return tables;
  },

  // Recommended questions for the current schema
  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: { questions: { type: "array", items: { type: "string" }, additionalProperties: false } },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(DB.schema());
    }
    return DB.questionInfo;
  },

  upload: async function (file) {
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(file.name, e.target.result);
        // Copy tables from the uploaded database to the default database
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" });
        for (const { name, sql } of tables) {
          db.exec(`DROP TABLE IF EXISTS "${name}"`);
          db.exec(sql);
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, { rowMode: "object" });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const sql = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
            const stmt = db.prepare(sql);
            db.exec("BEGIN TRANSACTION");
            for (const row of data) stmt.bind(columns.map((c) => row[c])).stepReset();
            db.exec("COMMIT");
            stmt.finalize();
          }
        }
        uploadDB.close();
        resolve();
      };
      fileReader.readAsArrayBuffer(file);
    });
    notify("success", "Imported", `Imported SQLite DB: ${file.name}`);
  },

  uploadDSV: async function (file, separator) {
    const fileReader = new FileReader();
    const result = await new Promise((resolve) => {
      fileReader.onload = (e) => {
        const rows = dsvFormat(separator).parse(e.target.result, autoType);
        resolve(rows);
      };
      fileReader.readAsText(file);
    });
    const tableName = file.name.slice(0, -4).replace(/[^a-zA-Z0-9_]/g, "_");
    await DB.insertRows(tableName, result);
  },

  insertRows: async function (tableName, result) {
    // Create table by auto-detecting column types
    const cols = Object.keys(result[0]);
    const typeMap = Object.fromEntries(
      cols.map((col) => {
        const sampleValue = result[0][col];
        let sqlType = "TEXT";
        if (typeof sampleValue === "number") sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean")
          sqlType = "INTEGER"; // SQLite has no boolean
        else if (sampleValue instanceof Date) sqlType = "TEXT"; // Store dates as TEXT
        return [col, sqlType];
      }),
    );
    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.map((col) => `[${col}] ${typeMap[col]}`).join(", ")})`;
    db.exec(createTableSQL);

    // Insert data
    const insertSQL = `INSERT INTO ${tableName} (${cols.map((col) => `[${col}]`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    const stmt = db.prepare(insertSQL);
    db.exec("BEGIN TRANSACTION");
    for (const row of result) {
      stmt
        .bind(
          cols.map((col) => {
            const value = row[col];
            return value instanceof Date ? value.toISOString() : value;
          }),
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
    notify("success", "Imported", `Imported table: ${tableName}`);
  },
};

$tablesContainer.addEventListener("input", (e) => {
  const $context = e.target.closest("#context");
  if ($context) DB.context = $context.value;
});

$upload.addEventListener("change", async (e) => {
  const uploadPromises = Array.from(e.target.files).map((file) => DB.upload(file));
  await Promise.all(uploadPromises);
  drawTables();
});

// --------------------------------------------------------------------
// Render tables

async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion narrative mx-auto" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
      ${schema.map(
        ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >${name}</button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      `,
      )}
    </div>
  `;

  const query = () => html`
    <form class="mt-4 narrative mx-auto">
      <div class="row align-items-end">
        <div class="col-md-9 mb-3">
          <label for="context" class="form-label fw-bold">Provide context about your dataset:</label>
          <textarea class="form-control" name="context" id="context" rows="2">${DB.context}</textarea>
        </div>
        <div class="col-md-3 mb-3 text-end">
          <button id="llm-provider" type="button" class="btn btn-outline-primary">Configure LLM Provider</button>
        </div>
      </div>
      <div class="mb-3">
        <label for="query" class="form-label fw-bold">Ask a question about your data:</label>
        <textarea class="form-control" name="query" id="query" rows="3"></textarea>
      </div>
      <button type="submit" class="btn btn-primary">Submit</button>
    </form>
  `;

  render([tables, ...(schema.length ? [html`<div class="text-center my-3">${loading}</div>`, query()] : [])], $tablesContainer);
  if (!schema.length) return;

  const $query = $tablesContainer.querySelector("#query");
  $query.scrollIntoView({ behavior: "smooth", block: "center" });
  $query.focus();
  DB.questions().then(({ questions, error }) => {
    if (error) return notify("danger", "Error", JSON.stringify(error));
    render(
      [
        tables,
        html`<div class="mx-auto narrative my-3">
          <h2 class="h6">Sample questions</h2>
          <ul>
            ${questions.map((q) => html`<li><a href="#" class="question">${q}</a></li>`)}
          </ul>
        </div>`,
        query(),
      ],
      $tablesContainer,
    );
    $query.focus();
  });
}

// --------------------------------------------------------------------
// Handle chat

$tablesContainer.addEventListener("click", async (e) => {
  const $question = e.target.closest(".question");
  if ($question) {
    e.preventDefault();
    $tablesContainer.querySelector("#query").value = $question.textContent;
    $tablesContainer.querySelector('form button[type="submit"]').click();
  }
  const $llmProvider = e.target.closest("#llm-provider");
  if ($llmProvider) {
    e.preventDefault();
    await openaiConfig({ show: true });
  }
});

$tablesContainer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const query = formData.get("query");
  render(html`<div class="text-center my-3">${loading}</div>`, $sql);
  render(html``, $result);
  const result = await llm({
    system: `You are an expert SQLite query writer. The user has a SQLite dataset.

${DB.context}

This is their SQLite schema:

${DB.schema()
  .map(({ sql }) => sql)
  .join("\n\n")}

Answer the user's question following these steps:

1. Guess their objective in asking this.
2. Describe the steps to achieve this objective in SQL.
3. Build the logic for the SQL query by identifying the necessary tables and relationships. Select the appropriate columns based on the user's question and the dataset.
4. Write SQL to answer the question. Use SQLite syntax.

Replace generic filter values (e.g. "a location", "specific region", etc.) by querying a random value from data.
Always use [Table].[Column].
`,
    user: query,
  });
  render(html`${unsafeHTML(marked.parse(result))}`, $sql);

  // Extract everything inside {lang?}...```
  const sql = result.match(/```.*?\n(.*?)```/s)?.[1] ?? result;
  try {
    const data = db.exec(sql, { rowMode: "object" });

    // Render the data using the utility function
    if (data.length > 0) {
      latestQueryResult = data;
      const actions = html`
        <div class="row align-items-center g-2">
          <div class="col-auto">
            <button id="download-button" type="button" class="btn btn-primary">
              <i class="bi bi-filetype-csv"></i>
              Download CSV
            </button>
          </div>
          <div class="col">
            <input
              type="text"
              id="chart-input"
              name="chart-input"
              class="form-control"
              placeholder="Describe what you want to chart"
              value="Draw the most appropriate chart to visualize this data"
            />
          </div>
          <div class="col-auto">
            <button id="chart-button" type="button" class="btn btn-primary">
              <i class="bi bi-bar-chart-line"></i>
              Draw Chart
            </button>
          </div>
        </div>
      `;
      const tableHtml = renderTable(data.slice(0, 100));
      render([actions, tableHtml], $result);
    } else {
      render(html`<p>No results found.</p>`, $result);
    }
  } catch (e) {
    render(html`<div class="alert alert-danger">${e.message}</div>`, $result);
    console.error(e);
  }
});

// --------------------------------------------------------------------
// Utilities

function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove("text-bg-success", "text-bg-danger", "text-bg-warning", "text-bg-info");
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

async function llm({ system, user, schema }) {
  const { baseUrl, apiKey } = await openaiConfig();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema } } } : {}),
    }),
  }).then((r) => r.json());
  if (response.error) return response;
  const content = response.choices?.[0]?.message?.content;
  try {
    return schema ? JSON.parse(content) : content;
  } catch (e) {
    return { error: e };
  }
}

// Utility function to render a table
function renderTable(data) {
  const columns = Object.keys(data[0]);
  return html`
    <table class="table table-striped table-hover">
      <thead>
        <tr>
          ${columns.map((col) => html`<th>${col}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${data.map(
          (row) => html`
            <tr>
              ${columns.map((col) => html`<td>${row[col]}</td>`)}
            </tr>
          `,
        )}
      </tbody>
    </table>
  `;
}

$result.addEventListener("click", async (e) => {
  const $downloadButton = e.target.closest("#download-button");
  if ($downloadButton && latestQueryResult.length > 0) {
    download(dsvFormat(",").format(latestQueryResult), "datachat.csv", "text/csv");
  }
  const $chartButton = e.target.closest("#chart-button");
  if ($chartButton && latestQueryResult.length > 0) {
    const system = `Write JS code to draw a ChartJS chart.
Write the code inside a \`\`\`js code fence.
\`Chart\` is already imported.
Data is ALREADY available as \`data\`, an array of objects. Do not create it. Just use it.
Render inside a <canvas id="chart"> like this:

\`\`\`js
return new Chart(
  document.getElementById("chart"),
  {
    type: "...",
    options: { ... },
    data: { ... },
  }
)
\`\`\`
`;
    const user = `
Question: ${$tablesContainer.querySelector('[name="query"]').value}

// First 3 rows of result
data = ${JSON.stringify(latestQueryResult.slice(0, 3))}

IMPORTANT: ${$result.querySelector("#chart-input").value}
`;
    render(loading, $chartCode);
    const result = await llm({ system, user });
    render(html`${unsafeHTML(marked.parse(result))}`, $chartCode);
    const code = result.match(/```js\n(.*?)\n```/s)?.[1];
    if (!code) {
      notify("danger", "Error", "Could not generate chart code");
      return;
    }

    try {
      const drawChart = new Function("Chart", "data", code);
      if (latestChart) latestChart.destroy();
      latestChart = drawChart(Chart, latestQueryResult);
    } catch (error) {
      notify("danger", "Error", `Failed to draw chart: ${error.message}`);
      console.error(error);
    }
  }
});

// --------------------------------------------------------------------
// Function to download CSV file
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
