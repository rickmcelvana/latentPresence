//! The companion's schedules (P6-T07b, ADR-57): when they fire, what a missed firing does.

pub mod cron;
pub mod model;
pub mod plan;
pub mod runner;

#[cfg(test)]
mod fixtures;
