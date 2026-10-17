# The desktop app

latentPresence for Windows (P8-T01, ADR-60): the web app in a Tauri window, with the companion
running inside the same process. Build the installer from the repo root:

```bash
pnpm desktop:build
```

It lands in `src-tauri/target/release/bundle/nsis/`. `pnpm gate` checks the shell on Windows.

## Icons

`icon.svg` is the master (the latentPresence mark: a dark tile, one thin ring, a dot held between
two teal arcs; colours are the ADR-15 tokens by value). The files in `src-tauri/icons/` are
generated from it:

```bash
cd apps/desktop && npx tauri icon icon.svg -o <a scratch folder>
```

then copy over only the files already in `src-tauri/icons/` — the CLI also writes `64x64.png`,
`android/` and `ios/`, which no target uses. The mark lived in `site/img/` until the site left
this repository (2026-10-17).
