export * from './messages';
export * from './voices';
export * from './webgpu';
// **The ungated `create*Worker` functions are deliberately not re-exported** (P1-T13).
// A worker that exists can fetch weights, so the only exported way to make one is
// `consent/gated-workers.ts`, which calls `requireConsent` first. Leaving the ungated
// version reachable would make "nothing downloads without the consent screen"
// (`CLAUDE.md`, ADR-09) a convention a future caller could bypass by accident; withheld,
// it is a compile error. Workers and live checks import `./create-worker` by path.
