//! Times at the edge (P4-T02).
//!
//! The protocol's timestamps are ISO-8601 strings with a `Z` or an offset
//! (`TimestampSchema`); the tables hold `DATETIME(3)` written in UTC with no offset of its
//! own (ADR-35: not `TIMESTAMP`, which converts through the session time zone and ends in
//! 2038). So every timestamp is converted exactly once, at the boundary: parsed and
//! normalised to UTC on the way in, formatted back out with a trailing `Z` and milliseconds
//! on the way out. Nothing in between carries an offset to lose.

use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};

use crate::DbError;

/// Parse an ISO-8601 timestamp (with an offset or `Z`) into the UTC value the schema
/// stores. Any offset is applied and then discarded — `DATETIME(3)` has none of its own.
pub fn parse_timestamp(input: &str) -> Result<NaiveDateTime, DbError> {
    let parsed = DateTime::parse_from_rfc3339(input)
        .map_err(|error| DbError::Invalid(format!("bad timestamp {input:?}: {error}")))?;
    Ok(parsed.with_timezone(&Utc).naive_utc())
}

/// Format a UTC `DATETIME(3)` value back out as the protocol expects: milliseconds, `Z`.
pub fn format_timestamp(value: NaiveDateTime) -> String {
    DateTime::<Utc>::from_naive_utc_and_offset(value, Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A `DATETIME(3)` as MariaDB's JSON functions render it inside a `JSON_OBJECT(...)`:
/// `"YYYY-MM-DD HH:MM:SS[.ffffff]"`, space-separated, no offset — not the protocol's own
/// ISO-8601. Used only to read the retrieval statement's computed rows back out.
pub fn parse_sql_datetime(input: &str) -> Result<NaiveDateTime, DbError> {
    NaiveDateTime::parse_from_str(input, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(input, "%Y-%m-%d %H:%M:%S"))
        .map_err(|error| DbError::Backend(format!("bad SQL datetime {input:?}: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_json_object_datetime_parses_and_reformats_as_iso8601() {
        let parsed = parse_sql_datetime("2026-09-27 12:34:56.789000").expect("parses");
        assert_eq!(format_timestamp(parsed), "2026-09-27T12:34:56.789Z");
        let no_fraction = parse_sql_datetime("2026-09-27 12:34:56").expect("parses");
        assert_eq!(format_timestamp(no_fraction), "2026-09-27T12:34:56.000Z");
    }

    #[test]
    fn a_z_timestamp_round_trips_through_utc() {
        let parsed = parse_timestamp("2026-09-27T12:34:56.789Z").expect("parses");
        assert_eq!(format_timestamp(parsed), "2026-09-27T12:34:56.789Z");
    }

    #[test]
    fn an_offset_is_applied_and_then_discarded() {
        // Noon in +02:00 is 10:00 UTC.
        let parsed = parse_timestamp("2026-09-27T12:00:00+02:00").expect("parses");
        assert_eq!(format_timestamp(parsed), "2026-09-27T10:00:00.000Z");
    }

    #[test]
    fn a_timestamp_with_no_offset_is_refused() {
        assert!(parse_timestamp("2026-09-27T12:00:00").is_err());
    }

    #[test]
    fn garbage_is_refused_with_a_message_naming_the_input() {
        let error = parse_timestamp("not a time").unwrap_err().to_string();
        assert!(error.contains("not a time"), "{error}");
    }
}
