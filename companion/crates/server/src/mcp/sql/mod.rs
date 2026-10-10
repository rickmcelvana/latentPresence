//! The person's own databases as companion tool servers, read-only (P5-T05, ADR-46).
//!
//! Each database in `mcp.json`'s `databases` is a server of its own, `sql:<name>`, so the page's
//! gate asks per database: trusting a hobby SQLite file is not trusting the shop's Postgres.
//! Two tools: `describe` (tables and columns, or one table with a few of its rows) and `query`.
//! The page's permission card shows her SQL before it runs — the preview and the confirm.
//!
//! Three layers keep it read-only, and each holds without the others: the guard (one query
//! that reads, in the database's own grammar), the database's own read-only transaction or
//! file mode, and the time and row limits. The person can add a fourth: a database user that
//! may only read.

pub mod backend;
pub mod guard;

use std::time::Duration;

use serde_json::{Value, json};

use super::config::DatabaseSpec;
use super::{CallOutcome, ToolInfo};
use backend::{Backend, Table};
use guard::Flavor;

/// One page of a result, in bytes: under the page's 8 000-character cut (as Files' pages).
const PAGE_BYTES: usize = 6000;
/// A cell longer than this is cut where it is shown.
const CELL_CHARS: usize = 200;
/// Sample rows `describe` shows for one table.
const SAMPLE_ROWS: usize = 3;
/// The schema read at most: a column a row.
const SCHEMA_ROWS: usize = 20_000;

pub struct SqlServer {
    name: String,
    description: Option<String>,
    row_limit: usize,
    backend: Backend,
}

/// A table as the schema lists it: how she names it, how SQL names it, its columns.
struct TableInfo {
    shown: String,
    quoted: String,
    columns: Vec<(String, String)>,
}

fn text(message: impl Into<String>) -> CallOutcome {
    CallOutcome::text(false, message)
}

fn refuse(message: impl Into<String>) -> CallOutcome {
    CallOutcome::text(true, message)
}

/// `"` for Postgres and SQLite, `` ` `` for MySQL, doubled inside.
fn quote(flavor: Flavor, part: &str) -> String {
    let mark = if flavor == Flavor::MySql { '`' } else { '"' };
    let doubled = part.replace(mark, &format!("{mark}{mark}"));
    format!("{mark}{doubled}{mark}")
}

fn cell(value: Option<&String>) -> String {
    let Some(value) = value else {
        return "NULL".into();
    };
    let flat: String = value
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let flat = flat.replace('|', "\\|");
    match flat.char_indices().nth(CELL_CHARS) {
        Some((at, _)) => format!("{}…", &flat[..at]),
        None => flat,
    }
}

/// Rows as lines she can read, `a | b`, within a page; the last line says how many and why
/// any are missing.
fn render(table: &Table, row_limit: usize) -> String {
    if table.columns.is_empty() {
        return "No rows.".into();
    }
    let mut out = table.columns.join(" | ");
    let mut shown = 0;
    for row in &table.rows {
        let line = row
            .iter()
            .map(Option::as_ref)
            .map(cell)
            .collect::<Vec<_>>()
            .join(" | ");
        if out.len() + line.len() + 1 > PAGE_BYTES {
            break;
        }
        out.push('\n');
        out.push_str(&line);
        shown += 1;
    }
    let count = table.rows.len();
    let tail = if shown < count {
        format!(
            "[{shown} of the {count} rows read are shown; the rest did not fit. Select fewer columns, or fewer rows.]"
        )
    } else if table.more {
        format!(
            "[The first {count} rows: the limit is {row_limit}, and there are more. Narrow the query, or count or group instead.]"
        )
    } else if count == 1 {
        "[1 row]".into()
    } else {
        format!("[{count} rows]")
    };
    format!("{out}\n{tail}")
}

impl SqlServer {
    /// Open the database the entry names; the error says why without its address.
    pub async fn connect(name: &str, spec: &DatabaseSpec) -> Result<Self, String> {
        let DatabaseSpec::Ready {
            source,
            description,
            row_limit,
            timeout_ms,
        } = spec
        else {
            let DatabaseSpec::Invalid(why) = spec else {
                unreachable!()
            };
            return Err(format!("mcp.json: {why}"));
        };
        let backend = Backend::connect(source, Duration::from_millis(*timeout_ms)).await?;
        Ok(Self {
            name: name.to_owned(),
            description: description.clone(),
            row_limit: *row_limit,
            backend,
        })
    }

    pub async fn close(&self) {
        self.backend.close().await;
    }

    fn dialect(&self) -> &'static str {
        match self.backend.flavor() {
            Flavor::Postgres => "PostgreSQL",
            Flavor::MySql => "MySQL/MariaDB",
            Flavor::Sqlite => "SQLite",
        }
    }

    pub fn instructions(&self) -> String {
        let about = self
            .description
            .as_ref()
            .map(|text| format!(" ({text})"))
            .unwrap_or_default();
        format!(
            "Read-only: the person's {} database \"{}\"{about}. Describe it before you query it, and write {} SQL.",
            self.backend.server,
            self.name,
            self.dialect()
        )
    }

    pub fn tools(&self) -> Vec<ToolInfo> {
        let read_only =
            json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
        vec![
            ToolInfo::new(
                "describe",
                "See what is in this database: its tables and their columns, or, given a table, its columns and a few of its rows. Do this before writing a query.",
                json!({ "type": "object", "properties": { "table": { "type": "string", "description": "One table to look at closely. Leave it out to list them all." } } }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "query",
                &format!(
                    "Run one {} query that only reads (SELECT, or WITH … SELECT) and see its rows, at most {}. Anything that would change data is refused. The person sees the query before it runs.",
                    self.dialect(),
                    self.row_limit
                ),
                json!({ "type": "object", "properties": { "sql": { "type": "string", "description": "One SELECT query." } }, "required": ["sql"] }),
                read_only,
            ),
        ]
    }

    pub async fn call(&self, name: &str, args: &serde_json::Map<String, Value>) -> CallOutcome {
        let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim();
        match name {
            "describe" => self.describe(arg("table")).await,
            "query" => self.query(arg("sql")).await,
            other => refuse(format!("{} has no tool called {other}.", self.name)),
        }
    }

    async fn query(&self, sql: &str) -> CallOutcome {
        if let Err(why) = guard::check(self.backend.flavor(), sql) {
            return refuse(why);
        }
        match self.backend.run(sql, self.row_limit).await {
            Ok(table) => text(render(&table, self.row_limit)),
            Err(why) => refuse(format!("The database said: {why}")),
        }
    }

    /// Every table and view the connection can see, with its columns in order.
    async fn tables(&self) -> Result<Vec<TableInfo>, String> {
        let flavor = self.backend.flavor();
        let sql = match flavor {
            Flavor::Postgres => {
                "SELECT c.table_schema::text, c.table_name::text, c.column_name::text, c.data_type::text \
                 FROM information_schema.columns c \
                 WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema') AND c.table_schema NOT LIKE 'pg\\_%' \
                 ORDER BY c.table_schema, c.table_name, c.ordinal_position"
            }
            Flavor::MySql => {
                "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), CAST(COLUMN_TYPE AS CHAR) \
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() \
                 ORDER BY TABLE_NAME, ORDINAL_POSITION"
            }
            Flavor::Sqlite => {
                "SELECT 'main', m.name, p.name, p.type FROM sqlite_schema AS m JOIN pragma_table_info(m.name) AS p \
                 WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 ORDER BY m.name, p.cid"
            }
        };
        let rows = self.backend.run(sql, SCHEMA_ROWS).await?.rows;
        let mut tables: Vec<TableInfo> = Vec::new();
        for row in rows {
            let [schema, table, column, kind] =
                [0, 1, 2, 3].map(|i| row.get(i).cloned().flatten().unwrap_or_default());
            let shown = if flavor == Flavor::Postgres && schema != "public" {
                format!("{schema}.{table}")
            } else {
                table.clone()
            };
            if tables.last().is_none_or(|last| last.shown != shown) {
                let quoted = if flavor == Flavor::Postgres {
                    format!("{}.{}", quote(flavor, &schema), quote(flavor, &table))
                } else {
                    quote(flavor, &table)
                };
                tables.push(TableInfo {
                    shown,
                    quoted,
                    columns: Vec::new(),
                });
            }
            if let Some(last) = tables.last_mut() {
                last.columns.push((column, kind.to_lowercase()));
            }
        }
        Ok(tables)
    }

    async fn describe(&self, table: &str) -> CallOutcome {
        let tables = match self.tables().await {
            Ok(tables) => tables,
            Err(why) => return refuse(format!("The database said: {why}")),
        };
        let columns = |info: &TableInfo| {
            info.columns
                .iter()
                .map(|(name, kind)| format!("{name} {kind}"))
                .collect::<Vec<_>>()
                .join(", ")
        };
        if table.is_empty() {
            if tables.is_empty() {
                return text(format!(
                    "{} ({}) has no tables this connection can see.",
                    self.name, self.backend.server
                ));
            }
            let head = format!(
                "{} ({}), {} table(s):",
                self.name,
                self.backend.server,
                tables.len()
            );
            let full: Vec<String> = tables
                .iter()
                .map(|info| format!("{}: {}", info.shown, columns(info)))
                .collect();
            let tail = "[Describe one table by name to see a few of its rows.]";
            let whole = format!("{head}\n{}\n{tail}", full.join("\n"));
            if whole.len() <= PAGE_BYTES {
                return text(whole);
            }
            // Too many to list with columns: the names, as many as fit.
            let mut out = format!("{head}\n");
            let mut listed = 0;
            for info in &tables {
                if out.len() + info.shown.len() + 120 > PAGE_BYTES {
                    break;
                }
                out.push_str(&info.shown);
                out.push('\n');
                listed += 1;
            }
            if listed < tables.len() {
                out.push_str(&format!("… and {} more.\n", tables.len() - listed));
            }
            out.push_str("[Too many to show their columns here: describe one table by name.]");
            return text(out);
        }
        let wanted = table.trim_matches(['"', '`']).to_lowercase();
        let found = tables.iter().find(|info| {
            info.shown.to_lowercase() == wanted
                || info
                    .shown
                    .rsplit('.')
                    .next()
                    .is_some_and(|bare| bare.to_lowercase() == wanted)
        });
        let Some(info) = found else {
            let names: Vec<&str> = tables
                .iter()
                .take(40)
                .map(|info| info.shown.as_str())
                .collect();
            return refuse(format!(
                "{} has no table called {table}. It has: {}{}",
                self.name,
                names.join(", "),
                if tables.len() > names.len() {
                    ", …"
                } else {
                    ""
                }
            ));
        };
        let sample = format!("SELECT * FROM {} LIMIT {SAMPLE_ROWS}", info.quoted);
        let rows = match self.backend.run(&sample, SAMPLE_ROWS).await {
            Ok(rows) => render(&rows, SAMPLE_ROWS),
            Err(why) => format!("(its rows could not be read: {why})"),
        };
        text(format!(
            "{}: {}\nA few rows:\n{rows}",
            info.shown,
            columns(info)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(rows: usize, more: bool) -> Table {
        Table {
            columns: vec!["name".into(), "note".into()],
            rows: (0..rows)
                .map(|n| vec![Some(format!("herb {n}")), None])
                .collect(),
            more,
        }
    }

    #[test]
    fn rows_are_lines_with_a_last_line_that_says_how_many_and_why_any_are_missing() {
        assert_eq!(
            render(&table(2, false), 100),
            "name | note\nherb 0 | NULL\nherb 1 | NULL\n[2 rows]"
        );
        assert!(render(&table(100, true), 100).ends_with("[The first 100 rows: the limit is 100, and there are more. Narrow the query, or count or group instead.]"));
        let wide = Table {
            columns: vec!["text".into()],
            rows: (0..500).map(|_| vec![Some("x".repeat(400))]).collect(),
            more: false,
        };
        let page = render(&wide, 1000);
        assert!(page.len() < PAGE_BYTES + 200);
        assert!(
            page.contains("of the 500 rows read are shown; the rest did not fit"),
            "{}",
            &page[page.len() - 200..]
        );
        assert_eq!(render(&Table::default(), 100), "No rows.");
    }

    #[test]
    fn a_cell_is_one_line_and_cannot_fake_a_column() {
        assert_eq!(cell(Some(&"a|b\nc".to_owned())), "a\\|b c");
        assert!(cell(Some(&"é".repeat(500))).ends_with('…'));
        assert_eq!(cell(None), "NULL");
    }

    #[test]
    fn identifiers_are_quoted_in_each_dialect_with_the_mark_doubled() {
        assert_eq!(
            quote(Flavor::Postgres, "my \"herbs\""),
            "\"my \"\"herbs\"\"\""
        );
        assert_eq!(quote(Flavor::MySql, "a`b"), "`a``b`");
        assert_eq!(quote(Flavor::Sqlite, "herbs"), "\"herbs\"");
    }
}
