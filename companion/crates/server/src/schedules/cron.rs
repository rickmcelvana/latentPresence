//! When a companion schedule fires (P6-T07b, ADR-57): the core's `scheduler/cron.ts` in Rust, on
//! croner-rust 4.0.1 and chrono-tz. Five fields in the schedule's own IANA zone, day of month
//! and day of week OR'd; a sixth field (seconds) and unknown zones are refused in words. Held to
//! the core's firing fixtures (`packages/core/src/scheduler/fixtures/firings.json`), so the two
//! schedulers agree on when a schedule fires.

use std::str::FromStr;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use croner::Cron;
use croner::parser::{CronParser, Seconds, Year};
use serde::{Deserialize, Serialize};

/// When a schedule fires: the protocol's `ScheduleTriggerSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Trigger {
    #[serde(rename = "cron", rename_all = "camelCase")]
    Cron {
        expression: String,
        time_zone: String,
    },
    #[serde(rename = "once")]
    Once { at: String },
}

/// A parsed five-field expression in its zone.
pub struct Times {
    cron: Cron,
    zone: Tz,
}

impl Times {
    pub fn parse(expression: &str, zone: &str) -> Result<Self, String> {
        let fields = expression.split_whitespace().count();
        if fields != 5 {
            return Err(format!(
                "\"{expression}\" has {fields} fields; a schedule takes five (minute hour day month weekday)"
            ));
        }
        let zone = Tz::from_str(zone)
            .map_err(|_| format!("\"{zone}\" is not a time zone the companion knows"))?;
        let cron = CronParser::builder()
            .seconds(Seconds::Disallowed)
            .year(Year::Disallowed)
            .dom_and_dow(false)
            .build()
            .parse(expression)
            .map_err(|error| format!("\"{expression}\" is not a schedule: {error}"))?;
        Ok(Self { cron, zone })
    }

    /// The first firing at or after `from` (`inclusive`) or strictly after it.
    fn find(&self, from: DateTime<Utc>, inclusive: bool) -> Option<DateTime<Utc>> {
        self.cron
            .find_next_occurrence(&from.with_timezone(&self.zone), inclusive)
            .ok()
            .map(|time| time.with_timezone(&Utc))
    }

    /// The first firing strictly after `after`.
    pub fn next(&self, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.find(after, false)
    }
}

pub fn parse_instant(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| format!("\"{value}\" is not a timestamp"))
}

/// The first firing strictly after `after`; none for a one-shot that has passed.
pub fn next_firing(
    trigger: &Trigger,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, String> {
    match trigger {
        Trigger::Once { at } => {
            let at = parse_instant(at)?;
            Ok((at > after).then_some(at))
        }
        Trigger::Cron {
            expression,
            time_zone,
        } => Ok(Times::parse(expression, time_zone)?.next(after)),
    }
}

/// Every firing from `from` to `to`, both inclusive, at most `limit`, and whether more were left out.
pub fn firings_between(
    trigger: &Trigger,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: usize,
) -> Result<(Vec<DateTime<Utc>>, bool), String> {
    let mut times = Vec::new();
    match trigger {
        Trigger::Once { at } => {
            let at = parse_instant(at)?;
            if at >= from && at <= to {
                times.push(at);
            }
            Ok((times, false))
        }
        Trigger::Cron {
            expression,
            time_zone,
        } => {
            let cron = Times::parse(expression, time_zone)?;
            let mut cursor = cron.find(from, true);
            while let Some(time) = cursor {
                if time > to {
                    return Ok((times, false));
                }
                if times.len() == limit {
                    return Ok((times, true));
                }
                times.push(time);
                cursor = cron.next(time + Duration::zero());
            }
            Ok((times, false))
        }
    }
}
