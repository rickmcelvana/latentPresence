//! The protocol's `Schedule` and `ScheduleRun` (`packages/protocol/src/schedule.ts`), field for
//! field — the routes take and give them, and the companion's runner reads and moves its own on.
//! The integration tests validate every response against the generated OpenAPI file.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::cron::Trigger;

/// A tool-only job's one call (ADR-57).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub server_id: String,
    pub name: String,
    pub arguments: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub schedule_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: String,
    pub summary: String,
    pub error: Option<String>,
    #[serde(default)]
    pub scheduled_for: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub character_id: String,
    pub description: String,
    pub trigger: Trigger,
    pub task_prompt: String,
    pub allowed_tools: Vec<String>,
    pub delivery: String,
    pub catch_up: String,
    pub run_on: String,
    pub status: String,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub tool_call: Option<ToolCall>,
    #[serde(default)]
    pub last_run: Option<Run>,
}

const DELIVERIES: [&str; 3] = ["speak_next_session", "notify", "silent_log"];
const CATCH_UPS: [&str; 3] = ["skip", "run_once", "run_all"];
const RUNNERS: [&str; 2] = ["core", "companion"];
const STATUSES: [&str; 5] = ["active", "paused", "completed", "failed", "cancelled"];
const OUTCOMES: [&str; 3] = ["ok", "failed", "skipped"];

impl Schedule {
    /// The enums and bounds serde does not check: what zod would refuse, refused here in words.
    pub fn validate(&self) -> Result<(), String> {
        let one_of = |field: &str, value: &str, allowed: &[&str]| {
            if allowed.contains(&value) {
                Ok(())
            } else {
                Err(format!("{field} {value:?} is not one of {allowed:?}"))
            }
        };
        if self.id.is_empty() || self.id.chars().count() > 128 {
            return Err("id must be 1 to 128 characters".into());
        }
        if self.character_id.is_empty() || self.character_id.chars().count() > 64 {
            return Err("characterId must be 1 to 64 characters".into());
        }
        let length = self.description.chars().count();
        if length == 0 || length > 200 {
            return Err("description must be 1 to 200 characters".into());
        }
        one_of("delivery", &self.delivery, &DELIVERIES)?;
        one_of("catchUp", &self.catch_up, &CATCH_UPS)?;
        one_of("runOn", &self.run_on, &RUNNERS)?;
        one_of("status", &self.status, &STATUSES)?;
        if let Some(run) = &self.last_run {
            one_of("lastRun.outcome", &run.outcome, &OUTCOMES)?;
        }
        Ok(())
    }
}
