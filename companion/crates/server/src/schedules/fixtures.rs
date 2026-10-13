//! The companion's scheduler against the core's fixtures (P6-T07b, ADR-57): the same file
//! `packages/core/src/scheduler/fixtures.test.ts` holds the core to.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;

use super::cron::{Times, Trigger, parse_instant};
use super::plan::plan_schedule;

const FIXTURES: &str =
    include_str!("../../../../../packages/core/src/scheduler/fixtures/firings.json");

#[derive(Deserialize)]
struct Fixtures {
    firings: Vec<FiringCase>,
    plans: Vec<PlanCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FiringCase {
    name: String,
    expression: String,
    time_zone: String,
    after: String,
    count: usize,
    next: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCase {
    name: String,
    trigger: Trigger,
    catch_up: String,
    next_run_at: String,
    now: String,
    expected: Option<ExpectedPlan>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct ExpectedPlan {
    run: Vec<String>,
    skipped: usize,
    next: Option<String>,
}

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn fixtures() -> Fixtures {
    serde_json::from_str(FIXTURES).expect("the fixtures parse")
}

#[test]
fn every_firing_case_fires_when_the_core_says() {
    let mut wrong = Vec::new();
    for case in fixtures().firings {
        let times = Times::parse(&case.expression, &case.time_zone).expect("the case parses");
        let mut cursor = parse_instant(&case.after).expect("a timestamp");
        let mut got = Vec::new();
        while got.len() < case.count {
            let Some(next) = times.next(cursor) else {
                break;
            };
            got.push(iso(next));
            cursor = next;
        }
        if got != case.next {
            wrong.push(format!(
                "{}: core {:?}, companion {:?}",
                case.name, case.next, got
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn every_plan_case_plans_as_the_core_does() {
    let mut wrong = Vec::new();
    for case in fixtures().plans {
        let plan = plan_schedule(
            &case.trigger,
            &case.catch_up,
            "active",
            Some(&case.next_run_at),
            parse_instant(&case.now).expect("now"),
        )
        .expect("the case plans")
        .map(|plan| ExpectedPlan {
            run: plan.run.into_iter().map(iso).collect(),
            skipped: plan.skipped,
            next: plan.next.map(iso),
        });
        if plan != case.expected {
            wrong.push(format!(
                "{}: core {:?}, companion {:?}",
                case.name, case.expected, plan
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn refuses_six_fields_and_unknown_zones_in_words() {
    assert!(
        Times::parse("0 0 9 * * *", "UTC")
            .err()
            .unwrap_or_default()
            .contains("6 fields")
    );
    assert!(
        Times::parse("0 9 * * *", "Mars/Base")
            .err()
            .unwrap_or_default()
            .contains("not a time zone")
    );
    assert!(Times::parse("61 * * * *", "UTC").is_err());
}
