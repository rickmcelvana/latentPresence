# Plugins

The plugins listed in latentPresence's index (ADR-72), one folder each: Tarot and Office (Rick's) and
Wheel of the Year (by midnight, Apache-2.0, written from `docs/plugins.md` alone; R-70). Each has `plugin.json`, its instructions and
data, and its assets or their pinned addresses. The format is `PluginManifest` in
`packages/protocol/src/plugin.ts`; editors validate against
`packages/protocol/src/generated/plugin.schema.json`.

```bash
pnpm plugin:check plugins/tarot
```

```bash
pnpm plugin:check plugins/office
```

```bash
pnpm plugin:check plugins/wheel-of-the-year
```

`--fetch` also downloads and checks every asset at an address; `--pin` writes each asset's size and
SHA-256 into `plugin.json` first. The gate checks every folder here (`packages/plugin-tools`).
The authoring guide is `docs/plugins.md`; `template/` is the folder it says to copy. The index on
latentpresence.com (`plugins/index.json` in the site's repository) is written by `pnpm plugin:index`,
from a pushed commit (ADR-72 item 9).
