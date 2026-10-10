//! P5-T05 (ADR-46): the layers under the guard hold on their own. Every write here goes straight
//! to `Backend::run`, past the parser, and must fail, and the rows must be as they were after;
//! the guard is then checked to refuse the same text. A query past its time is stopped, and a
//! query past its rows stops reading.
//!
//! SQLite runs always. MariaDB/MySQL runs with `LP_TEST_DATABASE_URL` (a probe table of its own,
//! dropped after) and Postgres with `LP_TEST_POSTGRES_URL` (CI's service); without them those
//! tests are skipped with an `eprintln!`, not failed.

use std::time::{Duration, Instant};

use latentpresence_companion::mcp::sql::backend::{Backend, Source};
use latentpresence_companion::mcp::sql::guard::{self, Flavor};

/// The time limit these tests give a query: short, so a stopped one does not slow the suite.
const LIMIT: Duration = Duration::from_millis(500);

fn probe_name(what: &str) -> String {
    format!("lp_sql_probe_{what}_{}", std::process::id())
}

/// Writes every database must refuse, by the table they aim at.
fn writes(flavor: Flavor, table: &str, many: &str) -> Vec<String> {
    let mut writes = vec![
        format!("INSERT INTO {table} (name, price) VALUES ('Mandrake', 9.0)"),
        format!("UPDATE {table} SET price = 0"),
        format!("DELETE FROM {table}"),
        format!("DROP TABLE {many}"),
        format!("CREATE TABLE {table}_copy AS SELECT * FROM {table}"),
        format!("ALTER TABLE {table} ADD COLUMN extra INT"),
    ];
    match flavor {
        Flavor::Postgres => writes.extend([
            format!("TRUNCATE {many}"),
            format!("WITH gone AS (DELETE FROM {table} RETURNING *) SELECT count(*) FROM gone"),
            format!("SELECT nextval('{table}_id_seq')"),
            "CREATE TEMP TABLE scratch (a int)".to_owned(),
            format!("CREATE INDEX {table}_name ON {table} (name)"),
        ]),
        Flavor::MySql => writes.extend([
            format!("TRUNCATE TABLE {many}"),
            format!("REPLACE INTO {table} (id, name) VALUES (1, 'Mandrake')"),
            format!("INSERT INTO {table} (name) SELECT name FROM {table}"),
            format!("CREATE INDEX {table}_name ON {table} (name)"),
            format!("RENAME TABLE {many} TO {many}_moved"),
        ]),
        Flavor::Sqlite => writes.extend([
            format!("REPLACE INTO {table} (id, name) VALUES (1, 'Mandrake')"),
            "PRAGMA user_version = 7".to_owned(),
            "VACUUM".to_owned(),
            format!("CREATE INDEX {table}_name ON {table} (name)"),
            format!("CREATE TRIGGER t AFTER INSERT ON {table} BEGIN SELECT 1; END"),
        ]),
    }
    writes
}

/// A query that would run for a long time, to be stopped. MariaDB stops a recursive CTE at
/// 1,001 rows (measured: it answered in 46 ms), so it gets a cross join.
fn slow(flavor: Flavor, many: &str) -> String {
    match flavor {
        Flavor::Postgres => "SELECT pg_sleep(30)".to_owned(),
        Flavor::MySql => format!(
            "SELECT SUM(a.n * b.n * c.n * d.n * e.n) FROM {many} a, {many} b, {many} c, {many} d, {many} e"
        ),
        Flavor::Sqlite => {
            "WITH RECURSIVE r (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r".to_owned()
        }
    }
}

/// Reads work, the row limit stops reading, every write fails at the database (and the guard
/// refuses it too), and a slow query is stopped. `rows` counts through the fixture's own
/// writable connection: (herbs, many).
async fn holds<F, Fut>(backend: &Backend, flavor: Flavor, table: &str, many: &str, rows: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = (i64, i64)>,
{
    let read = backend
        .run(&format!("SELECT name FROM {table} ORDER BY name"), 100)
        .await
        .expect("a read runs");
    let names: Vec<_> = read.rows.iter().map(|row| row[0].clone()).collect();
    assert_eq!(
        names,
        [
            Some("Basil".into()),
            Some("Sage".into()),
            Some("Yarrow".into())
        ]
    );
    assert!(!read.more);

    let limited = backend
        .run(&format!("SELECT * FROM {many}"), 100)
        .await
        .expect("a big read runs");
    assert_eq!((limited.rows.len(), limited.more), (100, true));

    for sql in writes(flavor, table, many) {
        let outcome = backend.run(&sql, 100).await;
        eprintln!(
            "{flavor:?} past the guard: {sql} → {:?}",
            outcome.as_ref().map(|_| "RAN")
        );
        assert!(
            outcome.is_err(),
            "{flavor:?} ran a write past the guard: {sql}"
        );
        assert!(
            guard::check(flavor, &sql).is_err(),
            "{flavor:?} guard let through: {sql}"
        );
    }
    assert_eq!(rows().await, (3, 150), "{flavor:?}: the rows changed");

    let started = Instant::now();
    let stopped = backend.run(&slow(flavor, many), 100).await;
    let took = started.elapsed();
    eprintln!("{flavor:?} slow query → {stopped:?} after {took:?}");
    assert!(stopped.is_err(), "{flavor:?}: a slow query was not stopped");
    assert!(
        took < LIMIT + Duration::from_secs(3),
        "{flavor:?}: stopped only after {took:?}"
    );

    // The connection it ran on is still good for the next question.
    let again = backend
        .run(&format!("SELECT COUNT(*) FROM {table}"), 1)
        .await
        .expect("reads again");
    assert_eq!(again.rows[0][0].as_deref(), Some("3"));
}

#[tokio::test]
async fn sqlite_stays_read_only_past_the_guard() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("garden.sqlite");
    let fixture = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .expect("opens");
    for sql in [
        "CREATE TABLE herbs (id INTEGER PRIMARY KEY, name TEXT, price REAL)",
        "INSERT INTO herbs (name, price) VALUES ('Basil', 2.5), ('Sage', 3.0), ('Yarrow', 1.75)",
        "CREATE TABLE many (n INTEGER)",
        "WITH RECURSIVE r (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 150) INSERT INTO many SELECT n FROM r",
    ] {
        sqlx::query(sql).execute(&fixture).await.expect("fixture");
    }
    let backend = Backend::connect(&Source::SqliteFile(path.clone()), LIMIT)
        .await
        .expect("connects read-only");
    assert_eq!(backend.flavor(), Flavor::Sqlite);
    assert!(
        backend.server.starts_with("SQLite 3."),
        "{}",
        backend.server
    );
    let other = dir
        .path()
        .join("other.db")
        .display()
        .to_string()
        .replace('\\', "/");
    let attached = backend
        .run(&format!("ATTACH DATABASE '{other}' AS other"), 1)
        .await;
    eprintln!(
        "Sqlite past the guard: ATTACH → {:?}",
        attached.as_ref().map(|_| "RAN")
    );
    let counts = || async {
        let herbs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM herbs")
            .fetch_one(&fixture)
            .await
            .expect("count");
        let many: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM many")
            .fetch_one(&fixture)
            .await
            .expect("count");
        (herbs, many)
    };
    holds(&backend, Flavor::Sqlite, "herbs", "many", counts).await;
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&fixture)
        .await
        .expect("pragma");
    assert_eq!(version, 0);
    backend.close().await;
    fixture.close().await;
}

#[tokio::test]
async fn mariadb_stays_read_only_past_the_guard() {
    use sqlx::mysql::MySqlPool;
    let Ok(url) = std::env::var("LP_TEST_DATABASE_URL") else {
        eprintln!("mariadb read-only test skipped: LP_TEST_DATABASE_URL is not set");
        return;
    };
    let fixture = MySqlPool::connect(&url).await.expect("connects");
    let (table, many) = (probe_name("herbs"), probe_name("many"));
    let setup = [
        format!("DROP TABLE IF EXISTS {table}, {many}, {table}_copy"),
        format!(
            "CREATE TABLE {table} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40), price DECIMAL(6,2))"
        ),
        format!(
            "INSERT INTO {table} (name, price) VALUES ('Basil', 2.5), ('Sage', 3.0), ('Yarrow', 1.75)"
        ),
        format!("CREATE TABLE {many} (n INT)"),
        format!(
            "INSERT INTO {many} WITH RECURSIVE r (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 150) SELECT n FROM r"
        ),
    ];
    for sql in &setup {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone()))
            .execute(&fixture)
            .await
            .expect("fixture");
    }
    let backend = Backend::connect(&Source::Url(url.clone()), LIMIT)
        .await
        .expect("connects read-only");
    eprintln!("connected to {}", backend.server);
    let decimal = backend
        .run(
            &format!("SELECT price FROM {table} WHERE name = 'Yarrow'"),
            1,
        )
        .await
        .expect("reads a decimal");
    assert_eq!(decimal.rows[0][0].as_deref(), Some("1.75"));
    // Under MySQL's escaping this is one string literal: harmless, and still one statement.
    let escaped = backend
        .run(
            &format!("SELECT COUNT(*) FROM {table} WHERE name = 'a\\' ; DROP TABLE {table}; -- '"),
            1,
        )
        .await;
    eprintln!("MySql backslash literal → {escaped:?}");
    let counts = || async {
        let herbs: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&fixture)
                .await
                .expect("count");
        let many: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {many}")))
                .fetch_one(&fixture)
                .await
                .expect("count");
        (herbs, many)
    };
    holds(&backend, Flavor::MySql, &table, &many, counts).await;
    let temp = backend
        .run("CREATE TEMPORARY TABLE lp_scratch (a INT)", 1)
        .await;
    eprintln!(
        "MySql past the guard: CREATE TEMPORARY TABLE → {:?}",
        temp.as_ref().map(|_| "RAN")
    );
    backend.close().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP TABLE IF EXISTS {table}, {many}, {table}_copy, {many}_moved"
    )))
    .execute(&fixture)
    .await
    .expect("cleanup");
    fixture.close().await;
}

#[tokio::test]
async fn postgres_stays_read_only_past_the_guard() {
    use sqlx::postgres::PgPool;
    let Ok(url) = std::env::var("LP_TEST_POSTGRES_URL") else {
        eprintln!("postgres read-only test skipped: LP_TEST_POSTGRES_URL is not set");
        return;
    };
    let fixture = PgPool::connect(&url).await.expect("connects");
    let (table, many) = (probe_name("herbs"), probe_name("many"));
    let setup = [
        format!("DROP TABLE IF EXISTS {table}, {many}, {table}_copy"),
        format!("CREATE TABLE {table} (id SERIAL PRIMARY KEY, name TEXT, price NUMERIC(6,2))"),
        format!(
            "INSERT INTO {table} (name, price) VALUES ('Basil', 2.5), ('Sage', 3.0), ('Yarrow', 1.75)"
        ),
        format!("CREATE TABLE {many} AS SELECT generate_series(1, 150) AS n"),
    ];
    for sql in &setup {
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.clone()))
            .execute(&fixture)
            .await
            .expect("fixture");
    }
    let backend = Backend::connect(&Source::Url(url.clone()), LIMIT)
        .await
        .expect("connects read-only");
    eprintln!("connected to {}", backend.server);
    let typed = backend
        .run(&format!("SELECT price, now() AS at, gen_random_uuid() AS id, '{{\"a\":1}}'::jsonb AS doc FROM {table} WHERE name = 'Yarrow'"), 1)
        .await
        .expect("reads numeric, timestamptz, uuid and jsonb");
    eprintln!("Postgres types → {:?}", typed.rows);
    assert_eq!(typed.rows[0][0].as_deref(), Some("1.75"));
    assert!(
        typed.rows[0]
            .iter()
            .all(|cell| cell.as_deref().is_some_and(|text| !text.starts_with('(')))
    );
    let counts = || async {
        let herbs: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                .fetch_one(&fixture)
                .await
                .expect("count");
        let many: i64 =
            sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {many}")))
                .fetch_one(&fixture)
                .await
                .expect("count");
        (herbs, many)
    };
    holds(&backend, Flavor::Postgres, &table, &many, counts).await;
    backend.close().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP TABLE IF EXISTS {table}, {many}, {table}_copy"
    )))
    .execute(&fixture)
    .await
    .expect("cleanup");
    fixture.close().await;
}
