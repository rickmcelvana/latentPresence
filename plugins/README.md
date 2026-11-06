# Plugins

First-party plugins for latentPresence (ADR-72), one folder each: `plugin.json`, its instructions and
data, and its assets or their pinned addresses. The format is `PluginManifest` in
`packages/protocol/src/plugin.ts`; editors validate against
`packages/protocol/src/generated/plugin.schema.json`.

```bash
pnpm plugin:check plugins/tarot
```

`--fetch` also downloads and checks every asset at an address; `--pin` writes each asset's size and
SHA-256 into `plugin.json` first. The gate checks every folder here (`packages/plugin-tools`).
The authoring guide is P10-T09's.
