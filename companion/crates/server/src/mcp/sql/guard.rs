//! The first of the read-only layers (ADR-46): what she wrote must parse, in the database's own
//! dialect, as exactly one query that only reads.
//!
//! This is not the guarantee — the read-only transaction is (`backend`). It is what turns most
//! mistakes and every multi-statement trick into a plain answer before anything reaches the
//! database, and it refuses what a read-only transaction does not stop: reading the server's
//! files, reaching another server, sleeping, taking locks. Anything it cannot parse is refused:
//! a parser that disagrees with the server is where injections live, so the doubt goes to "no".

use std::ops::ControlFlow;

use sqlparser::ast::{Expr, ObjectName, Query, Select, SetExpr, Statement, Visit, Visitor};
use sqlparser::dialect::{Dialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

/// Which grammar a database speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Postgres,
    MySql,
    Sqlite,
}

impl Flavor {
    fn dialect(self) -> Box<dyn Dialect> {
        match self {
            Self::Postgres => Box::new(PostgreSqlDialect {}),
            Self::MySql => Box::new(MySqlDialect {}),
            Self::Sqlite => Box::new(SQLiteDialect {}),
        }
    }
}

/// Functions a read-only transaction would still run: the server's files, other servers,
/// sleeping, locks, settings, sequences and signals. By the last part of the name, any case.
fn refused_function(name: &str) -> bool {
    const EXACT: &[&str] = &[
        // Postgres
        "set_config",
        "nextval",
        "setval",
        "lowrite",
        "loread",
        "query_to_xml",
        "query_to_xml_and_xmlschema",
        "query_to_xmlschema",
        "cursor_to_xml",
        "cursor_to_xmlschema",
        // MySQL and MariaDB
        "sleep",
        "benchmark",
        "load_file",
        "get_lock",
        "release_lock",
        "release_all_locks",
        "is_free_lock",
        "is_used_lock",
        "master_pos_wait",
        "source_pos_wait",
        "master_gtid_wait",
        "wait_for_executed_gtid_set",
        "wait_until_sql_thread_after_gtids",
        "sys_exec",
        "sys_eval",
        // SQLite
        "load_extension",
        "readfile",
        "writefile",
        "edit",
        "fts3_tokenizer",
    ];
    const PREFIXES: &[&str] = &[
        "pg_sleep",
        "pg_read",
        "pg_ls_",
        "pg_stat_file",
        "pg_file",
        "pg_terminate",
        "pg_cancel",
        "pg_reload",
        "pg_rotate",
        "pg_advisory",
        "pg_try_advisory",
        "pg_notify",
        "pg_switch",
        "pg_promote",
        "pg_create",
        "pg_drop",
        "pg_replication",
        "pg_logical",
        "pg_log_backend",
        "pg_wal",
        "pg_backup",
        "pg_import",
        "lo_",
        "dblink",
    ];
    let name = name.to_ascii_lowercase();
    EXACT.contains(&name.as_str()) || PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

fn last_part(name: &ObjectName) -> String {
    name.0
        .last()
        .map(|part| part.to_string().trim_matches(['"', '`']).to_owned())
        .unwrap_or_default()
}

struct ReadsOnly;

impl Visitor for ReadsOnly {
    type Break = String;

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<String> {
        // A query inside a query is fine; anything else inside one (a data-modifying CTE) is not.
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break("it changes data inside the query".into())
        }
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<String> {
        if !query.locks.is_empty() {
            return ControlFlow::Break("it locks rows (FOR UPDATE / FOR SHARE)".into());
        }
        if query.for_clause.is_some() {
            return ControlFlow::Break("it has a FOR clause".into());
        }
        if matches!(
            *query.body,
            SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_)
        ) {
            return ControlFlow::Break("it changes data".into());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<String> {
        if select.into.is_some() {
            return ControlFlow::Break("SELECT … INTO writes a table or a file".into());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_relation(&mut self, relation: &ObjectName) -> ControlFlow<String> {
        // `FROM dblink(...)`, `FROM pg_ls_dir(...)`: a function in the FROM clause is a relation here.
        let name = last_part(relation);
        if refused_function(&name) {
            return ControlFlow::Break(format!("{name} reaches outside the database's tables"));
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<String> {
        if let Expr::Function(function) = expr {
            let name = last_part(&function.name);
            if refused_function(&name) {
                return ControlFlow::Break(format!(
                    "{name}() is not something a read-only question may call"
                ));
            }
        }
        ControlFlow::Continue(())
    }
}

/// `Ok` when `sql` is one query that only reads; otherwise the words for her, which start with
/// what was refused so she can say it and write another.
pub fn check(flavor: Flavor, sql: &str) -> Result<(), String> {
    let refused = |why: &str| {
        Err(format!(
            "Not run: {why}. Only one query that reads (SELECT, or WITH … SELECT) can run here."
        ))
    };
    if sql.trim().is_empty() {
        return refused("there is no query");
    }
    // MySQL runs what is inside `/*! … */` and MariaDB inside `/*M! … */`: a comment to the
    // parser, code to the server. Never let the two disagree.
    if flavor == Flavor::MySql {
        let lower = sql.to_ascii_lowercase();
        if lower.contains("/*!") || lower.contains("/*m!") {
            return refused("it has a /*! … */ comment, which MySQL and MariaDB run as code");
        }
    }
    let statements = match Parser::parse_sql(flavor.dialect().as_ref(), sql) {
        Ok(statements) => statements,
        Err(error) => return refused(&format!("it could not be read as SQL ({error})")),
    };
    let statement = match statements.as_slice() {
        [] => return refused("there is no query"),
        [statement] => statement,
        _ => return refused("it is more than one statement"),
    };
    if !matches!(statement, Statement::Query(_)) {
        let word = statement
            .to_string()
            .split_whitespace()
            .next()
            .unwrap_or("it")
            .to_ascii_uppercase();
        return refused(&format!("{word} is not a query that reads"));
    }
    match statement.visit(&mut ReadsOnly) {
        ControlFlow::Break(why) => refused(&why),
        ControlFlow::Continue(()) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Flavor; 3] = [Flavor::Postgres, Flavor::MySql, Flavor::Sqlite];

    #[test]
    fn a_query_that_reads_passes_in_every_dialect() {
        for flavor in ALL {
            for sql in [
                "SELECT 1",
                "select name, price from herbs where price < 3 order by name limit 5;",
                "SELECT h.name, COUNT(*) FROM herbs h JOIN uses u ON u.herb_id = h.id GROUP BY h.name HAVING COUNT(*) > 1",
                "WITH cheap AS (SELECT * FROM herbs WHERE price < 3) SELECT name FROM cheap",
                "SELECT name FROM herbs UNION SELECT name FROM spices",
                "SELECT * FROM herbs WHERE name LIKE '%; DROP TABLE herbs; --%'",
                "SELECT (SELECT MAX(price) FROM herbs) AS top",
                "SELECT lower(name), coalesce(note, '') FROM herbs",
            ] {
                assert_eq!(check(flavor, sql), Ok(()), "{flavor:?}: {sql}");
            }
        }
    }

    /// The injection suite: what a model, or a document it read, might try. Every one is refused
    /// before it reaches a database, in every dialect it parses in.
    #[test]
    fn writes_stacked_statements_and_side_effects_are_refused() {
        let everywhere = [
            "DROP TABLE herbs",
            "DELETE FROM herbs",
            "UPDATE herbs SET price = 0",
            "INSERT INTO herbs (name) VALUES ('x')",
            "CREATE TABLE stolen AS SELECT * FROM herbs",
            "ALTER TABLE herbs ADD COLUMN x INT",
            "TRUNCATE TABLE herbs",
            "SELECT 1; DROP TABLE herbs",
            "SELECT 1; DELETE FROM herbs;",
            "SELECT * FROM herbs WHERE name = '' ; DROP TABLE herbs; --'",
            "BEGIN; DELETE FROM herbs; COMMIT",
            "SELECT * FROM herbs FOR UPDATE",
            "SELECT * INTO stolen FROM herbs",
            "GRANT ALL ON herbs TO PUBLIC",
            "SET autocommit = 1",
            "",
            "   ",
            "-- just a comment",
            "SELEC name FROM herbs",
        ];
        for flavor in ALL {
            for sql in everywhere {
                let outcome = check(flavor, sql);
                assert!(
                    matches!(&outcome, Err(why) if why.starts_with("Not run: ")),
                    "{flavor:?} let through: {sql}"
                );
            }
        }
        let by_dialect: &[(Flavor, &[&str])] = &[
            (
                Flavor::Postgres,
                &[
                    "WITH gone AS (DELETE FROM herbs RETURNING *) SELECT * FROM gone",
                    "WITH up AS (UPDATE herbs SET price = 0 RETURNING *) SELECT 1",
                    "SELECT pg_read_file('/etc/passwd')",
                    "SELECT pg_sleep(600)",
                    "SELECT * FROM pg_ls_dir('.')",
                    "SELECT * FROM dblink('host=elsewhere', 'DELETE FROM herbs') AS t(x int)",
                    "SELECT dblink_exec('host=elsewhere', 'DROP TABLE herbs')",
                    "SELECT set_config('default_transaction_read_only', 'off', false)",
                    "SELECT nextval('herbs_id_seq')",
                    "SELECT lo_export(1, '/tmp/out')",
                    "SELECT pg_terminate_backend(1)",
                    "SELECT query_to_xml('DELETE FROM herbs', true, true, '')",
                    "SELECT pg_advisory_lock(1)",
                    "SELECT PG_CATALOG.PG_READ_FILE('x')",
                    "COPY herbs TO '/tmp/herbs.csv'",
                    "CALL wipe()",
                    "DO $$ BEGIN DELETE FROM herbs; END $$",
                    "EXPLAIN ANALYZE DELETE FROM herbs",
                    "LOCK TABLE herbs",
                    "VACUUM",
                    "SELECT * FROM herbs FOR SHARE",
                    "PREPARE p AS DELETE FROM herbs",
                ],
            ),
            (
                Flavor::MySql,
                &[
                    "SELECT * FROM herbs /*! INTO OUTFILE '/tmp/herbs' */",
                    "SELECT 1 /*!50000 , (SELECT 1) */",
                    "SELECT 1 /*M! , 2 */",
                    "SELECT * FROM herbs INTO OUTFILE '/tmp/herbs'",
                    "SELECT LOAD_FILE('/etc/passwd')",
                    "SELECT SLEEP(600)",
                    "SELECT BENCHMARK(100000000, MD5('x'))",
                    "SELECT GET_LOCK('x', 10)",
                    "LOAD DATA INFILE '/tmp/x' INTO TABLE herbs",
                    "REPLACE INTO herbs (name) VALUES ('x')",
                    "HANDLER herbs OPEN",
                    "SELECT * FROM herbs LOCK IN SHARE MODE",
                    "SET SESSION TRANSACTION READ WRITE",
                    "CALL wipe()",
                    "SHOW GRANTS",
                ],
            ),
            (
                Flavor::Sqlite,
                &[
                    "ATTACH DATABASE '/tmp/x.db' AS x",
                    "PRAGMA writable_schema = 1",
                    "PRAGMA query_only = 0",
                    "VACUUM INTO '/tmp/copy.db'",
                    "SELECT load_extension('evil')",
                    "SELECT writefile('/tmp/x', 'y')",
                    "SELECT readfile('/etc/passwd')",
                    "INSERT OR REPLACE INTO herbs (name) VALUES ('x')",
                    "WITH x AS (SELECT 1) DELETE FROM herbs",
                    "DETACH DATABASE main",
                    "REINDEX",
                ],
            ),
        ];
        for (flavor, cases) in by_dialect {
            for sql in *cases {
                let outcome = check(*flavor, sql);
                assert!(
                    matches!(&outcome, Err(why) if why.starts_with("Not run: ")),
                    "{flavor:?} let through: {sql} → {outcome:?}"
                );
            }
        }
    }

    #[test]
    fn the_refusal_says_what_was_wrong() {
        let said = |sql| check(Flavor::Postgres, sql).expect_err("refused");
        assert!(said("DROP TABLE herbs").contains("DROP is not a query that reads"));
        assert!(said("SELECT 1; SELECT 2").contains("more than one statement"));
        assert!(said("SELECT pg_sleep(9)").contains("pg_sleep() is not"));
        assert!(
            check(Flavor::MySql, "SELECT 1 /*! , 2 */")
                .expect_err("refused")
                .contains("run as code")
        );
    }
}
