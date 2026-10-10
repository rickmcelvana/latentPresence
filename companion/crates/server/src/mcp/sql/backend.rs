//! The layers under the guard (ADR-46): each database's own read-only mode, a time limit the
//! server keeps, rows read until the limit and no further.
//!
//! - **Postgres**: every session starts `default_transaction_read_only = on` with a
//!   `statement_timeout`, and every query runs inside `BEGIN READ ONLY`, rolled back.
//! - **MySQL and MariaDB**: every session is `SET SESSION TRANSACTION READ ONLY` with
//!   `max_execution_time` (MySQL, ms) or `max_statement_time` (MariaDB, s), and every query runs
//!   inside `START TRANSACTION READ ONLY`, rolled back.
//! - **SQLite**: the file is opened read-only with `query_only`, and a progress handler
//!   interrupts a query past its time.
//!
//! Her SQL always goes through `sqlx::query`, a prepared statement: one statement, never the
//! text protocol, where MySQL would run several (`sqlx` turns `MULTI_STATEMENTS` on). A query
//! that outlives its time on the client too has its connection closed, not returned.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::types::{Decimal, Uuid};
use sqlx::{AssertSqlSafe, Column, Connection, Row, TypeInfo, ValueRef};

use super::guard::Flavor;

/// Where a database is: an address, or for SQLite a file.
#[derive(Clone, PartialEq, Eq)]
pub enum Source {
    Url(String),
    SqliteFile(PathBuf),
}

/// What a query read: its columns, the rows up to the limit, and whether there were more.
#[derive(Debug, Default)]
pub struct Table {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub more: bool,
}

enum Pool {
    Postgres(PgPool),
    MySql(MySqlPool),
    Sqlite(SqlitePool),
}

pub struct Backend {
    pool: Pool,
    source: Source,
    timeout: Duration,
    /// What the server says it is: "PostgreSQL 17.2", "MariaDB 11.8.3", "SQLite 3.50.4".
    pub server: String,
}

/// How long to wait for a connection from the pool: a busy server, not a dead one.
const ACQUIRE: Duration = Duration::from_secs(15);
/// Past the server's own limit, the client gives up too.
const GRACE: Duration = Duration::from_secs(2);

/// The secret part of an address: the password between `user:` and `@`. Never in a message.
fn password(url: &str) -> Option<&str> {
    let rest = &url[url.find("://")? + 3..];
    let credentials = &rest[..rest.find('@')?];
    let secret = &credentials[credentials.find(':')? + 1..];
    (!secret.is_empty()).then_some(secret)
}

/// An error as words for the person, with the address and its password taken out.
fn said(error: &sqlx::Error, source: &Source) -> String {
    let message = match error {
        sqlx::Error::Database(database) => database.message().to_owned(),
        other => other.to_string(),
    };
    match source {
        Source::Url(url) => {
            let mut message = message.replace(url.as_str(), "(its address)");
            if let Some(secret) = password(url) {
                message = message.replace(secret, "(password)");
            }
            message
        }
        Source::SqliteFile(_) => message,
    }
}

impl Backend {
    pub fn flavor(&self) -> Flavor {
        match self.pool {
            Pool::Postgres(_) => Flavor::Postgres,
            Pool::MySql(_) => Flavor::MySql,
            Pool::Sqlite(_) => Flavor::Sqlite,
        }
    }

    /// Open a small pool and ask the server what it is. Errors never carry the address.
    pub async fn connect(source: &Source, timeout: Duration) -> Result<Self, String> {
        let fail = |error: sqlx::Error| said(&error, source);
        let ms = timeout.as_millis().max(1);
        let (pool, server) = match source {
            Source::Url(url)
                if url.starts_with("postgres://") || url.starts_with("postgresql://") =>
            {
                let options = PgConnectOptions::from_str(url)
                    .map_err(fail)?
                    .application_name("latentpresence")
                    .options([
                        ("default_transaction_read_only", "on".to_owned()),
                        ("statement_timeout", ms.to_string()),
                        ("lock_timeout", ms.to_string()),
                        ("idle_in_transaction_session_timeout", (ms * 2).to_string()),
                    ]);
                let pool = PgPoolOptions::new()
                    .max_connections(2)
                    .acquire_timeout(ACQUIRE)
                    .connect_with(options)
                    .await
                    .map_err(fail)?;
                let version: String = sqlx::query_scalar("SHOW server_version")
                    .fetch_one(&pool)
                    .await
                    .map_err(fail)?;
                (Pool::Postgres(pool), format!("PostgreSQL {version}"))
            }
            Source::Url(url) if url.starts_with("mysql://") || url.starts_with("mariadb://") => {
                let url = url.replacen("mariadb://", "mysql://", 1);
                let options = MySqlConnectOptions::from_str(&url).map_err(fail)?;
                let pool = MySqlPoolOptions::new()
                    .max_connections(2)
                    .acquire_timeout(ACQUIRE)
                    .after_connect(move |connection, _| {
                        Box::pin(async move {
                            let version: String = sqlx::query_scalar("SELECT VERSION()")
                                .fetch_one(&mut *connection)
                                .await?;
                            let limit = if version.to_ascii_lowercase().contains("mariadb") {
                                format!("SET SESSION max_statement_time = {}", ms as f64 / 1000.0)
                            } else {
                                format!("SET SESSION max_execution_time = {ms}")
                            };
                            sqlx::raw_sql(AssertSqlSafe(limit))
                                .execute(&mut *connection)
                                .await?;
                            sqlx::raw_sql("SET SESSION TRANSACTION READ ONLY")
                                .execute(&mut *connection)
                                .await?;
                            Ok(())
                        })
                    })
                    .connect_with(options)
                    .await
                    .map_err(fail)?;
                let version: String = sqlx::query_scalar("SELECT VERSION()")
                    .fetch_one(&pool)
                    .await
                    .map_err(fail)?;
                let server = if version.to_ascii_lowercase().contains("mariadb") {
                    format!("MariaDB {}", version.split('-').next().unwrap_or(&version))
                } else {
                    format!("MySQL {version}")
                };
                (Pool::MySql(pool), server)
            }
            Source::Url(url) if url.starts_with("sqlite:") => {
                let options = SqliteConnectOptions::from_str(url).map_err(fail)?;
                Self::sqlite(options, fail).await?
            }
            Source::SqliteFile(path) => {
                if !path.is_file() {
                    return Err(format!("there is no file at {}", path.display()));
                }
                Self::sqlite(SqliteConnectOptions::new().filename(path), fail).await?
            }
            Source::Url(_) => {
                return Err(
                    "its address is not postgres://, mysql://, mariadb:// or sqlite:".into(),
                );
            }
        };
        Ok(Self {
            pool,
            source: source.clone(),
            timeout,
            server,
        })
    }

    async fn sqlite(
        options: SqliteConnectOptions,
        fail: impl Fn(sqlx::Error) -> String,
    ) -> Result<(Pool, String), String> {
        let options = options
            .read_only(true)
            .create_if_missing(false)
            .pragma("query_only", "ON");
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .acquire_timeout(ACQUIRE)
            .connect_with(options)
            .await
            .map_err(&fail)?;
        let version: String = sqlx::query_scalar("SELECT sqlite_version()")
            .fetch_one(&pool)
            .await
            .map_err(&fail)?;
        Ok((Pool::Sqlite(pool), format!("SQLite {version}")))
    }

    pub async fn close(&self) {
        match &self.pool {
            Pool::Postgres(pool) => pool.close().await,
            Pool::MySql(pool) => pool.close().await,
            Pool::Sqlite(pool) => pool.close().await,
        }
    }

    /// Run `sql` read-only and read at most `max_rows` rows. The guard has already passed it, or
    /// it is the companion's own (the schema); either way this layer holds without the guard.
    pub async fn run(&self, sql: &str, max_rows: usize) -> Result<Table, String> {
        let limit = self.timeout + GRACE;
        let late = || {
            format!(
                "it ran past its time limit of {} s and was stopped",
                self.timeout.as_secs_f64()
            )
        };
        let sql = AssertSqlSafe(sql.to_owned());
        let source = &self.source;
        match &self.pool {
            Pool::Postgres(pool) => {
                let mut connection = pool.acquire().await.map_err(|e| said(&e, source))?;
                let work = async {
                    let mut transaction = connection.begin_with("BEGIN READ ONLY").await?;
                    let table = read(
                        sqlx::query(sql).persistent(false).fetch(&mut *transaction),
                        max_rows,
                        postgres_cell,
                    )
                    .await;
                    transaction.rollback().await?;
                    table
                };
                match tokio::time::timeout(limit, work).await {
                    Ok(table) => table.map_err(|e| said(&e, source)),
                    Err(_) => {
                        let _ = connection.detach().close_hard().await;
                        Err(late())
                    }
                }
            }
            Pool::MySql(pool) => {
                let mut connection = pool.acquire().await.map_err(|e| said(&e, source))?;
                let work = async {
                    let mut transaction =
                        connection.begin_with("START TRANSACTION READ ONLY").await?;
                    let table = read(
                        sqlx::query(sql).persistent(false).fetch(&mut *transaction),
                        max_rows,
                        mysql_cell,
                    )
                    .await;
                    transaction.rollback().await?;
                    table
                };
                match tokio::time::timeout(limit, work).await {
                    Ok(table) => table.map_err(|e| said(&e, source)),
                    Err(_) => {
                        let _ = connection.detach().close_hard().await;
                        Err(late())
                    }
                }
            }
            Pool::Sqlite(pool) => {
                let mut connection = pool.acquire().await.map_err(|e| said(&e, source))?;
                let deadline = Instant::now() + self.timeout;
                connection
                    .lock_handle()
                    .await
                    .map_err(|e| said(&e, source))?
                    .set_progress_handler(1000, move || Instant::now() < deadline);
                let work = read(
                    sqlx::query(sql).persistent(false).fetch(&mut *connection),
                    max_rows,
                    sqlite_cell,
                );
                match tokio::time::timeout(limit, work).await {
                    // Interrupted by the progress handler: SQLite says only "interrupted".
                    Ok(Err(_)) if Instant::now() >= deadline => Err(late()),
                    Ok(table) => table.map_err(|e| said(&e, source)),
                    Err(_) => {
                        let _ = connection.detach().close_hard().await;
                        Err(late())
                    }
                }
            }
        }
    }
}

/// Read rows until `max_rows`, then one more to know whether there were more, then stop.
async fn read<'s, R: Row>(
    mut rows: futures_util::stream::BoxStream<'s, Result<R, sqlx::Error>>,
    max_rows: usize,
    cell: fn(&R, usize) -> Option<String>,
) -> Result<Table, sqlx::Error> {
    let mut table = Table::default();
    while let Some(row) = rows.try_next().await? {
        if table.columns.is_empty() {
            table.columns = row
                .columns()
                .iter()
                .map(|column| column.name().to_owned())
                .collect();
        }
        if table.rows.len() == max_rows {
            table.more = true;
            break;
        }
        table
            .rows
            .push((0..row.columns().len()).map(|i| cell(&row, i)).collect());
    }
    Ok(table)
}

/// Bytes as text when they are text; otherwise how many.
fn bytes(value: Vec<u8>) -> String {
    String::from_utf8(value).unwrap_or_else(|value| format!("({} bytes)", value.as_bytes().len()))
}

/// The first type the column decodes as, shown; `None` for NULL; the type's name for a type
/// this does not know, so she can cast it to text.
macro_rules! first_that_decodes {
    ($row:expr, $i:expr, $( $ty:ty => $show:expr ),+ $(,)?) => {{
        let row = $row;
        let i = $i;
        match row.try_get_raw(i) {
            Ok(value) if value.is_null() => return None,
            Ok(_) => {}
            Err(_) => return Some("(unreadable)".into()),
        }
        $(
            if let Ok(value) = row.try_get::<$ty, _>(i) {
                return Some(($show)(value));
            }
        )+
        let kind = row.columns()[i].type_info().name().to_owned();
        Some(format!("({kind}: cast it to text to read it)"))
    }};
}

fn postgres_cell(row: &PgRow, i: usize) -> Option<String> {
    first_that_decodes!(row, i,
        bool => |v: bool| v.to_string(),
        i16 => |v: i16| v.to_string(),
        i32 => |v: i32| v.to_string(),
        i64 => |v: i64| v.to_string(),
        f32 => |v: f32| v.to_string(),
        f64 => |v: f64| v.to_string(),
        Decimal => |v: Decimal| v.to_string(),
        String => |v: String| v,
        NaiveDate => |v: NaiveDate| v.to_string(),
        NaiveTime => |v: NaiveTime| v.to_string(),
        NaiveDateTime => |v: NaiveDateTime| v.to_string(),
        DateTime<Utc> => |v: DateTime<Utc>| v.to_rfc3339(),
        Uuid => |v: Uuid| v.to_string(),
        serde_json::Value => |v: serde_json::Value| v.to_string(),
        Vec<String> => |v: Vec<String>| format!("{{{}}}", v.join(",")),
        Vec<i64> => |v: Vec<i64>| format!("{v:?}"),
        Vec<i32> => |v: Vec<i32>| format!("{v:?}"),
        Vec<u8> => bytes,
    )
}

fn mysql_cell(row: &MySqlRow, i: usize) -> Option<String> {
    first_that_decodes!(row, i,
        i64 => |v: i64| v.to_string(),
        u64 => |v: u64| v.to_string(),
        f64 => |v: f64| v.to_string(),
        f32 => |v: f32| v.to_string(),
        Decimal => |v: Decimal| v.to_string(),
        String => |v: String| v,
        NaiveDateTime => |v: NaiveDateTime| v.to_string(),
        DateTime<Utc> => |v: DateTime<Utc>| v.to_rfc3339(),
        NaiveDate => |v: NaiveDate| v.to_string(),
        NaiveTime => |v: NaiveTime| v.to_string(),
        serde_json::Value => |v: serde_json::Value| v.to_string(),
        Vec<u8> => bytes,
    )
}

fn sqlite_cell(row: &SqliteRow, i: usize) -> Option<String> {
    first_that_decodes!(row, i,
        i64 => |v: i64| v.to_string(),
        f64 => |v: f64| v.to_string(),
        String => |v: String| v,
        Vec<u8> => bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_password_is_found_and_never_said() {
        assert_eq!(
            password("postgres://reader:s3cret@db:5432/shop"),
            Some("s3cret")
        );
        assert_eq!(password("mysql://reader@db/shop"), None);
        assert_eq!(password("sqlite:garden.db"), None);
        let source = Source::Url("postgres://reader:s3cret@db:5432/shop".into());
        let error = sqlx::Error::Protocol(
            "could not reach postgres://reader:s3cret@db:5432/shop (s3cret)".into(),
        );
        let message = said(&error, &source);
        assert!(!message.contains("s3cret"), "{message}");
        assert!(message.contains("(its address)"), "{message}");
    }
}
