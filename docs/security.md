# Security — what we defend, against whom, and how

P9-T03's review (2026-11-01, ADR-69). Kept current: a change to a boundary below changes this file.

## What is worth taking

- **Her memory** of the person (facts, episodes, plans, blocks, schedules) in MariaDB, through the companion.
- **API keys**: in the browser, encrypted with a non-extractable key (`settings/vault.ts`, which says
  plainly what that does not stop); in the desktop app, Windows Credential Manager.
- **What her tools reach**: files under the roots in `mcp.json`, the person's databases (read-only),
  Home Assistant (actions), the web.
- **The person's machine**: the companion runs MCP servers named in `mcp.json`, and the desktop app updates itself.

## Who we defend against

| Attacker | Reaches | Defence |
|---|---|---|
| A web site the person visits | `localhost` from their browser | CORS allowlist (`relay::cors`): only localhost pages, the desktop webview and the hosted app; the browser's own local-network prompt (ADR-64) |
| The same site, by **DNS rebinding** | Same-origin requests to the companion under its own name | `host.rs`: a request must name the companion by IP address or `localhost` (ADR-69) |
| Someone on the LAN | A companion bound with `COMPANION_HOST` | The pairing code on every request when the bind address is not loopback (ADR-69) |
| A page from the hosted app | The companion, after the person allows it | The pairing code (ADR-64) |
| Text she reads (a web page, a document, a tool result) — **prompt injection** | Her next tool call | The per-tool gate (ask / auto / never, a fingerprint on "always", ADR-42), Home Assistant per device (ADR-48), `read_page` refuses private addresses after DNS (`web/fetch.rs`), Files read-only inside canonical roots, databases read-only in three layers (ADR-46) |
| A script injected into the page | Keys, memory, the desktop shell's commands | No HTML sink in the code (React escapes); the **Content Security Policy** runs only the build's own scripts (`security/csp.ts`); the shell's commands cannot add a program to run (`config_edit::Change` has no command), and folders come only from a native picker |
| A forged update | The desktop app | minisign signatures checked by the updater (ADR-66, proved with a forged entry) |
| A moved or altered model download | What runs in the voice workers, and what a person agreed to | Every file pinned to a commit and checked against a SHA-256, on the wire and in the cache (ADR-70) |
| A dependency with a known advisory | Wherever it runs | Weekly `audit` workflow (`pnpm audit --prod`, `cargo audit` on both lockfiles) |

**Trusted, on purpose:** any program running as the person on this machine, and any page served
from `localhost`. The standalone companion answers both without a code (`pairing.rs` says why); the
desktop app's companion answers only its own webview (a per-launch token). The tool gate lives in the
page, so a local program calling `/mcp/call` is not asked — it could read the files itself.

## The review, 2026-11-01

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | Standalone companion: a rebound name's same-origin `GET`s carried no `Origin` and passed CORS and pairing — her memory, schedules and tool list readable by a web site | High | **Fixed**: `host.rs` (421 for any other name; live-checked with `curl -H 'Host: evil.example'`) |
| 2 | `COMPANION_HOST=0.0.0.0` opened every route to the LAN with no code, `/mcp/call` included | High | **Fixed**: the code from every request when not bound to loopback |
| 3 | No Content Security Policy, hosted or desktop | Medium | **Fixed**: a `<meta>` policy in every build; `e2e/csp.spec.ts` loads the built pages under it, the body included; `frame-ancestors`, `nosniff` and `Referrer-Policy` as Caddy headers (`docs/deploy.md`, on the server since 2026-11-03); the desktop webview checked over DevTools (D-67); a spoken call under the policy passed (R-65, D-68) |
| 4 | zod 4.5.4 (shipped): memory exhaustion on oversized constrained collections | Medium | **Fixed**: 4.6.7 |
| 5 | rustls, rustls-webpki, quinn-proto, ctutils, webpki-root-certs, tokio advisories in both Rust lockfiles | Medium | **Fixed**: patch updates; `cargo audit` clean but for four "unmaintained" warnings (font parsing, D-Bus) |
| 6 | undici 7.29.1 (eight advisories), via the AI SDK's Node path | Low (not in the bundle) | **Fixed**: override to 7.30.1 |
| 7 | sharp (libvips, libheif, librsvg advisories), transformers.js's Node image path | None shipped | **Ignored, with the reason**, in `pnpm-workspace.yaml` |
| 8 | Model and body downloads: Kokoro and Moonshine resolve a moving `main`, the placeholder body a moving `dev` branch; only the size is checked | Low | **Fixed** (P9-T05, ADR-70): 99 files pinned, each checked against its SHA-256 on arrival and in the cache; refused bytes are never stored; proved in a real browser |
| 9 | With an injected script, the desktop shell's `companion_config_change` could point Home Assistant at another URL and keep the token | Low (needs #3 broken) | Accepted behind the CSP; revisit if the shell grows commands |
| 10 | Found in P9-T05: the Kokoro, recognition and Smart Turn workers ran ONNX Runtime's `.mjs` from jsDelivr and fetched its wasm from there, unpinned and on no consent screen. The page's policy does not reach a worker | Medium | **Fixed** (ADR-70): both from the build; the build fails if a chunk would use the CDN (`security/cdn-guard.ts`); the Kokoro and recognition workers also refuse any other host |

Checked and sound: `read_page`'s SSRF guard (resolver-level, redirects, no proxy), the Files server's
containment (canonical paths, symlinks refused), ingest's limits (file size, a zip part, PDF parsing
under `catch_unwind`), the vault's honesty, source links (`http(s)` only), the secrets' scope (the
app's own Credential Manager service), and no `innerHTML`, `eval` or `new Function` in our code.

**What the page's policy does not cover.** A dedicated worker takes its policy from its own response's
headers, not from the page's `<meta>`: a worker imported a script from jsDelivr under `script-src 'self'`
(measured, finding 10). So `worker-src` limits which workers start, not what they then load. That is
what the fetch guard and `cdn-guard.ts` are for.
