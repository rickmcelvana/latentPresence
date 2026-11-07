# Plugins

First-party plugins for latentPresence (ADR-72), one folder each: `plugin.json`, its instructions and
data, and its assets or their pinned addresses. The format is `PluginManifest` in
`packages/protocol/src/plugin.ts`; editors validate against
`packages/protocol/src/generated/plugin.schema.json`.

```bash
pnpm plugin:check plugins/tarot
```

```bash
pnpm plugin:check plugins/office
```

`--fetch` also downloads and checks every asset at an address; `--pin` writes each asset's size and
SHA-256 into `plugin.json` first. The gate checks every folder here (`packages/plugin-tools`).
The authoring guide is `docs/plugins.md`; `template/` is the folder it says to copy. The index on
latentpresence.com (`plugins/index.json` in the site's repository) is written by `pnpm plugin:index`,
from a pushed commit (ADR-72 item 9).
