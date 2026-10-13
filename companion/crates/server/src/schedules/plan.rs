//! What to do about a due schedule now (P6-T07b, ADR-57): the core's `scheduler/plan.ts` in Rust,
//! held to the same fixtures. A firing found within five minutes is on time and runs whatever
//! the policy; older ones were missed: `skip` runs none, `run_once` the newest, `run_all` each
//! oldest first, at most ten.

use chrono::{DateTime, Duration, Utc};

use super::cron::{Trigger, firings_between, next_firing, parse_instant};

pub const LATE_GRACE: Duration = Duration::minutes(5);
pub const RUN_ALL_LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub run: Vec<DateTime<Utc>>,
    pub skipped: usize,
    pub next: Option<DateTime<Utc>>,
}

/// `None` when nothing is due: not active, no next run, or not yet.
pub fn plan_schedule(
    trigger: &Trigger,
    catch_up: &str,
    status: &str,
    next_run_at: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<Plan>, String> {
    let Some(next_run_at) = next_run_at else {
        return Ok(None);
    };
    if status != "active" {
        return Ok(None);
    }
    let due = parse_instant(next_run_at)?;
    if due > now {
        return Ok(None);
    }
    let (times, more) = firings_between(trigger, due, now, 1000)?;
    let next = next_firing(trigger, now)?;
    let (on_time, missed): (Vec<_>, Vec<_>) = times
        .iter()
        .copied()
        .partition(|time| now - *time <= LATE_GRACE);
    let missed_count = missed.len() + usize::from(more);
    if let Some(&last) = on_time.last() {
        if catch_up != "run_all" {
            return Ok(Some(Plan {
                run: vec![last],
                skipped: missed_count,
                next,
            }));
        }
        let keep = RUN_ALL_LIMIT.saturating_sub(1).min(missed.len());
        let mut run: Vec<_> = missed[missed.len() - keep..].to_vec();
        run.push(last);
        return Ok(Some(Plan {
            run,
            skipped: missed_count - keep,
            next,
        }));
    }
    Ok(match catch_up {
        "skip" => Some(Plan {
            run: Vec::new(),
            skipped: missed_count,
            next,
        }),
        "run_once" => Some(Plan {
            run: missed.last().map(|time| vec![*time]).unwrap_or_default(),
            skipped: missed_count.saturating_sub(1),
            next,
        }),
        "run_all" => {
            let keep = RUN_ALL_LIMIT.min(missed.len());
            Some(Plan {
                run: missed[missed.len() - keep..].to_vec(),
                skipped: missed_count - keep,
                next,
            })
        }
        _ => None,
    })
}
