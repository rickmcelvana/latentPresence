//! Secrets the companion's config files leave out (P8-T06, ADR-63).
//!
//! The desktop app edits `mcp.json` without writing a secret into it: the Home Assistant token,
//! the web search key and a database's address go to Windows Credential Manager instead, filed
//! under the same service as the app's API keys. A file entry that has no secret of its own falls
//! back to the one stored here, so the app's companion and a developer's `pnpm companion` on the
//! same machine read the same setup. A secret written in the file still wins: hand-edited files
//! keep working exactly as before.
//!
//! Elsewhere than Windows there is no store yet (the desktop app is Windows-only, ADR-07), and
//! every lookup is `None`.

/// The Credential Manager service: the desktop app files its API keys under the same one.
pub const SERVICE: &str = "latentPresence";

/// Home Assistant's long-lived access token.
pub const HOME_TOKEN: &str = "companion:homeAssistant.token";

/// The web search provider's key (Tavily or Brave).
pub const WEB_SEARCH_KEY: &str = "companion:web.search.key";

/// A listed database's address (it may hold a password).
pub fn database_url(name: &str) -> String {
    format!("companion:databases.{name}.url")
}

/// Looks a secret up by its account name. Injected, so a test never touches the OS store.
pub type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// No secrets at all: what a test, or a file read on its own terms, sees.
pub fn none(_: &str) -> Option<String> {
    None
}

/// The OS store: Windows Credential Manager. A missing entry, or one the store will not give, is
/// `None` — the entry then says what it lacks, as it would with nothing in the file.
#[cfg(windows)]
pub fn os(account: &str) -> Option<String> {
    keyring::v1::Entry::new(SERVICE, account)
        .ok()?
        .get_password()
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[cfg(not(windows))]
pub fn os(_: &str) -> Option<String> {
    None
}
