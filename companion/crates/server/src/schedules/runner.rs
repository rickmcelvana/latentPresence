//! The companion's own jobs (P6-T07b, ADR-57): `runOn: companion` schedules, run with no page
//! open — the core's `attachScheduler` for the one kind of job that needs no model. Every 30
//! seconds the due ones are planned (`plan_schedule`, held to the core's fixtures), **claimed**
//! (next run moved on and saved) and run: the schedule's one tool call through the MCP host, or,
//! with no call and no task prompt, a reminder whose description is the message. The run is kept
//! on the schedule, its summary written into memory as an episode in the schedule's own session,
//! and anything meant for the person waits (`deliveredAt` null) for the page to say it: the
//! companion has no voice and, until P8, no notifications.

use std::future::Future;
use std::time::Duration as StdDuration;

use chrono::{DateTime, SecondsFormat, Utc};
use latentpresence_db::store::{self, Registry, Role, StoreError};
use sqlx::mysql::MySqlPool;

use super::cron::parse_instant;
use super::model::{Run, Schedule, ToolCall};
use super::plan::plan_schedule;

/// How often the companion looks, as the core's tick.
pub const TICK: StdDuration = StdDuration::from_secs(30);
/// A tool's answer is a result to keep, not a document: this much of it is the summary.
const SUMMARY_CHARS: usize = 500;

/// What a schedule's call reaches: the MCP host, or a fake in tests.
pub trait ToolCaller: Send + Sync {
    /// The tool's text, or why it failed (an error result is a failure too).
    fn call(&self, call: &ToolCall) -> impl Future<Output = Result<String, String>> + Send;
}

fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clip(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= SUMMARY_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(SUMMARY_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The session a schedule's results are kept in — `scheduleSessionId` in the core.
pub fn schedule_session_id(schedule_id: &str) -> String {
    format!("schedule-{schedule_id}")
}

struct Outcome {
    ok: bool,
    summary: String,
    error: Option<String>,
}

async fn execute<C: ToolCaller>(caller: &C, schedule: &Schedule) -> Outcome {
    match &schedule.tool_call {
        Some(call) => match caller.call(call).await {
            Ok(text) => {
                let text = clip(&text);
                Outcome {
                    ok: true,
                    summary: if text.is_empty() {
                        format!("{}: done.", schedule.description)
                    } else {
                        text
                    },
                    error: None,
                }
            }
            Err(error) => Outcome {
                ok: false,
                summary: String::new(),
                error: Some(error),
            },
        },
        None if schedule.task_prompt.trim().is_empty() => Outcome {
            ok: true,
            summary: schedule.description.clone(),
            error: None,
        },
        None => Outcome {
            ok: false,
            summary: String::new(),
            error: Some(
                "it needs a model to think it through, and the companion only runs tool calls"
                    .into(),
            ),
        },
    }
}

async fn save(pool: &MySqlPool, schedule: &Schedule) -> Result<(), StoreError> {
    let row = crate::memory_api::schedule_row(schedule)
        .map_err(|_| StoreError::BadRequest(format!("schedule {} cannot be kept", schedule.id)))?;
    store::save_schedule(pool, &row, Utc::now().naive_utc()).await
}

/// Keep the run on the schedule as it is now: it may have been paused, edited or deleted meanwhile.
async fn keep(
    pool: &MySqlPool,
    schedule: &Schedule,
    run: Run,
    failed: bool,
) -> Result<(), StoreError> {
    let current = store::list_schedules(pool, &schedule.character_id)
        .await?
        .iter()
        .filter_map(|body| serde_json::from_str::<Schedule>(body).ok())
        .find(|candidate| candidate.id == schedule.id);
    let Some(mut current) = current else {
        return Ok(());
    };
    if failed
        && matches!(current.trigger, super::cron::Trigger::Once { .. })
        && current.status == "completed"
    {
        current.status = "failed".into();
    }
    current.last_run_at = Some(run.started_at.clone());
    current.last_run = Some(run);
    save(pool, &current).await
}

/// Runs what is due now; returns the runs kept, for the log and the tests.
pub async fn run_due<C: ToolCaller>(
    pool: &MySqlPool,
    registry: &Registry,
    caller: &C,
    now: impl Fn() -> DateTime<Utc>,
    new_id: impl Fn() -> String,
) -> Result<Vec<Run>, StoreError> {
    let at = now();
    let mut kept = Vec::new();
    for body in store::due_companion_schedules(pool, at.naive_utc()).await? {
        let Ok(schedule) = serde_json::from_str::<Schedule>(&body) else {
            continue;
        };
        let plan = match plan_schedule(
            &schedule.trigger,
            &schedule.catch_up,
            &schedule.status,
            schedule.next_run_at.as_deref(),
            at,
        ) {
            Ok(Some(plan)) => plan,
            Ok(None) => continue,
            Err(why) => {
                // A schedule it cannot read (a zone it does not know) fails, once.
                eprintln!("schedule {}: {why}", schedule.id);
                save(
                    pool,
                    &Schedule {
                        status: "failed".into(),
                        next_run_at: None,
                        ..schedule
                    },
                )
                .await?;
                continue;
            }
        };
        let claimed = Schedule {
            next_run_at: plan.next.map(iso),
            status: if plan.next.is_none() {
                "completed".into()
            } else {
                schedule.status.clone()
            },
            ..schedule.clone()
        };
        save(pool, &claimed).await?;

        for slot in &plan.run {
            let started_at = iso(now());
            let outcome = execute(caller, &claimed).await;
            let finished_at = iso(now());
            let summary = if outcome.ok {
                outcome.summary
            } else {
                format!(
                    "I couldn't do \"{}\": {}",
                    claimed.description,
                    outcome.error.clone().unwrap_or_default()
                )
            };
            let delivered_at = (claimed.delivery == "silent_log" || summary.is_empty())
                .then(|| finished_at.clone());
            let run = Run {
                id: new_id(),
                schedule_id: claimed.id.clone(),
                started_at,
                finished_at: Some(finished_at.clone()),
                outcome: if outcome.ok { "ok" } else { "failed" }.into(),
                summary: summary.clone(),
                error: outcome.error,
                scheduled_for: Some(iso(*slot)),
                delivered_at,
            };
            if !summary.is_empty() {
                let episode = store::Episode {
                    uid: format!("{}-said", run.id),
                    session_uid: schedule_session_id(&claimed.id),
                    character_id: claimed.character_id.clone(),
                    role: Role::Assistant,
                    text: summary,
                    interrupted: false,
                    at: parse_instant(&finished_at)
                        .map_err(StoreError::BadRequest)?
                        .naive_utc(),
                    embedding: None,
                    affect: None,
                };
                store::append_episode(pool, registry, &episode).await?;
            }
            keep(pool, &claimed, run.clone(), !outcome.ok).await?;
            kept.push(run);
        }
        if plan.run.is_empty() && plan.skipped > 0 {
            let skipped_at = iso(now());
            let run = Run {
                id: new_id(),
                schedule_id: claimed.id.clone(),
                started_at: skipped_at.clone(),
                finished_at: Some(skipped_at.clone()),
                outcome: "skipped".into(),
                summary: String::new(),
                error: None,
                scheduled_for: schedule.next_run_at.clone(),
                delivered_at: Some(skipped_at),
            };
            keep(pool, &claimed, run.clone(), false).await?;
            kept.push(run);
        }
    }
    Ok(kept)
}

/// The companion's tick: every `TICK`, for as long as it runs.
pub fn spawn<C: ToolCaller + 'static>(
    pool: MySqlPool,
    registry: std::sync::Arc<Registry>,
    caller: C,
) {
    tokio::spawn(async move {
        let count = std::sync::atomic::AtomicU64::new(0);
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let started = Utc::now().timestamp_millis();
            let new_id = || {
                let n = count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                format!("run-companion-{started:x}-{n:x}")
            };
            if let Err(error) = run_due(&pool, &registry, &caller, Utc::now, new_id).await {
                eprintln!("schedules: {error}");
            }
        }
    });
}

/// The MCP host answers a schedule's call as `/mcp/call` would; an error result is a failure.
impl ToolCaller for crate::mcp::SharedHost {
    fn call(&self, call: &ToolCall) -> impl Future<Output = Result<String, String>> + Send {
        let host = self.clone();
        let call = call.clone();
        async move {
            match host
                .call_tool(&call.server_id, &call.name, call.arguments)
                .await
            {
                Ok(outcome) if !outcome.is_error => Ok(outcome.text),
                Ok(outcome) => Err(clip(&outcome.text)),
                Err(error) => Err(error.message()),
            }
        }
    }
}
