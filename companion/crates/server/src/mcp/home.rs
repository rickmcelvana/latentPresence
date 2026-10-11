//! Home Assistant (P5-T07, ADR-48): the person's HA over its own MCP server, with HA's own
//! overview of the home served as the server's `instructions`.
//!
//! **The overview is HA's "Assist" prompt** — every exposed device with its names, domain and
//! areas — so the page's device policy and her prompt work from the names HA itself matches.
//! It is read when HA connects and again, at most once a minute, when the page lists tools: a
//! light added in HA reaches her without restarting the companion.

use std::time::Duration;

use rmcp::model::GetPromptRequestParams;

use super::Client;

/// The prompt HA serves for its Assist API (2026.9.4: one per LLM API, named after it).
pub const OVERVIEW_PROMPT: &str = "Assist";
/// How often a listing may read the overview again.
pub const OVERVIEW_EVERY: Duration = Duration::from_secs(60);
const OVERVIEW_TIMEOUT: Duration = Duration::from_secs(10);

/// HA's overview of the home, or `None` when it could not be read (the last one stays).
pub async fn overview(client: &Client) -> Option<String> {
    let request = client.get_prompt(GetPromptRequestParams::new(OVERVIEW_PROMPT));
    let result = tokio::time::timeout(OVERVIEW_TIMEOUT, request)
        .await
        .ok()?
        .ok()?;
    let texts: Vec<String> = result
        .messages
        .iter()
        .filter_map(|message| {
            let content = serde_json::to_value(&message.content).ok()?;
            content.get("text")?.as_str().map(str::to_owned)
        })
        .collect();
    (!texts.is_empty()).then(|| texts.join("\n\n"))
}

/// Why HA could not be reached, saying what to change where the cause is known.
pub fn failure(why: String) -> String {
    if why.contains("401") || why.contains("Unauthorized") {
        format!(
            "Home Assistant refused the token ({why}): make a new long-lived token and put it in \
             mcp.json"
        )
    } else if why.contains("404") || why.contains("Not Found") {
        format!(
            "Home Assistant has no MCP server there ({why}): add the \"Model Context Protocol \
             Server\" integration in Settings → Devices & services"
        )
    } else {
        why
    }
}
