# Decisions (ADR log)

One entry per decision. Status is `proposed` until Rick confirms, then `accepted`. Superseded entries stay, marked `superseded by ADR-xx`. Keep each entry short; link to `docs/RESEARCH.md` for the reasoning.

| ID | Decision | Status | Date |
|---|---|---|---|
| ADR-01 | Browser-first architecture; desktop and web share one frontend | proposed | 2026-09-07 |
| ADR-02 | TypeScript core + Rust companion; no Python in the core | proposed | 2026-09-07 |
| ADR-03 | Avatar is a full-body VRM 1.0 character in three.js, renderer behind a plugin interface | proposed | 2026-09-07 |
| ADR-04 | Vercel AI SDK as LLM and tool harness; MCP for tools | proposed | 2026-09-07 |
| ADR-05 | Memory kernel in TS with `MemoryStore` adapters; MariaDB 11.8 Vector is the primary store | proposed | 2026-09-07 |
| ADR-06 | Cascaded voice pipeline (VAD, STT, LLM, TTS) is the default; omni models are an optional provider | proposed | 2026-09-07 |
| ADR-07 | Desktop shell is Tauri 2, Windows and Linux first; macOS gated on WebKit spikes; Electron is the fallback | proposed | 2026-09-07 |
| ADR-08 | Smart home via Home Assistant MCP server only | proposed | 2026-09-07 |
| ADR-09 | No models shipped; runtime download from Hugging Face with licence display, or BYO endpoints | proposed | 2026-09-07 |
| ADR-10 | Code licence Apache-2.0 (alternative MIT) | proposed, needs Rick | 2026-09-07 |
| ADR-11 | Monorepo layout and toolchain (pnpm, Vite, React, R3F, Biome, Vitest, Playwright, cargo workspace) | proposed | 2026-09-07 |
| ADR-12 | Affect engine (PAD mood + discrete events) is the single source of truth for expression, gesture, voice style and wording | proposed | 2026-09-07 |
| ADR-13 | Agent workflow: Claude/DeepSeek plan and audit, Aider (Kimi K2.7 code via Ollama cloud) executes briefs, main AI auto-commits, Aider never commits | proposed | 2026-09-07 |

---

## ADR-01 Browser-first

The complete product runs in Chrome or Edge as a static site with no server, using WebGPU, AudioWorklet and Web Workers. The desktop app wraps the same build. Rationale: AIRI's Tauri to Electron migration shows that betting on a system webview for real-time audio is risky; a real Chromium is the reference target, and the hosted BYO web version comes for free. See RESEARCH §8.

## ADR-02 TypeScript core + Rust companion

`packages/core` (conversation engine, affect, memory kernel) is pure TypeScript with no DOM or Node dependencies so it runs in browser, worker, Node and Tauri. The companion is a Rust binary (axum) exposing a local HTTP and WebSocket API: MariaDB, document indexing, MCP host, optional GPU bridges. Python is never required to run latentAura.

## ADR-03 VRM full-body avatar behind a renderer plugin

`packages/avatar` exposes `AvatarRenderer` with `setExpression`, `setViseme`, `playGesture`, `lookAt`, `setPose`, `tick`. First implementation is VRM via three-vrm. LAM head or Gaussian body renderers can implement the same interface later. See RESEARCH §2.

## ADR-04 Vercel AI SDK + MCP

Streaming, tool calls, structured outputs and MCP client in one Apache-2.0 TypeScript library that runs in the browser. OpenAI-compatible provider covers Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA (Nemotron). Native Anthropic and Google adapters where features matter. See RESEARCH §4.

## ADR-05 Memory kernel with MariaDB Vector

Episodic log, bi-temporal facts, editable self-model blocks, plans. MariaDB 11.8 `VECTOR` columns and HNSW index for retrieval. `MemoryStore` adapters: `mariadb` (through companion), `sqlite` (desktop), `indexeddb` (web-only). See RESEARCH §6.

## ADR-06 Cascaded voice pipeline by default

Silero VAD, Smart Turn v3 (or adaptive silence), STT provider, LLM provider, sentence splitter, TTS provider, audio queue, lip sync. `OmniProvider` (audio in, audio out) is an optional path for models like Qwen3-Omni. See RESEARCH §3.

## ADR-07 Tauri 2 on Windows and Linux first

WebView2 is Chromium so Windows is safe. Linux WebKitGTK and macOS WKWebView get Phase 0 spikes (AudioWorklet, WebGPU, getUserMedia). If a platform fails, that platform ships as "companion + Chrome/Edge" with a documented Electron fallback. See RESEARCH §8.

## ADR-08 Smart home through Home Assistant

Home Assistant's MCP server exposes devices and intents, and HA already bridges Google Home and Alexa. We never write vendor skills.

## ADR-09 No models shipped

The repo and installers contain no model weights. Browser-side models (VAD, STT, TTS, SER, face) download from Hugging Face on first use behind an explicit consent screen that shows size and licence. Server-side models are the user's own endpoints.

## ADR-10 Licence

Recommendation: Apache-2.0 for the code. Assets (character, set, CC0 clips) under CC0 or CC-BY-4.0 as appropriate. Needs Rick's call.

## ADR-11 Monorepo and toolchain

```
latentAura/
  apps/web/            Vite + React app (the product)
  apps/desktop/        Tauri 2 shell (Phase 8)
  packages/core/       conversation engine, affect engine, memory kernel (pure TS)
  packages/providers/  llm, stt, tts, embeddings, omni adapters
  packages/avatar/     three.js / VRM renderer, animation, lip sync, set
  packages/protocol/   shared types and companion API schema (zod)
  packages/ml-web/     worker wrappers for transformers.js / onnxruntime-web models
  companion/           Rust workspace: server, db, ingest, mcp
  assets/              CC0 clips, set, default character (large files via git LFS)
  docs/
```
pnpm workspaces, Vite, React 19, react-three-fiber, @pixiv/three-vrm, zustand, zod, Biome, Vitest, Playwright, cargo workspace with axum, tokio, sqlx, serde.

## ADR-12 Affect engine

State: PAD mood vector (slow, persisted), discrete emotion events (fast, decaying), energy, and social stance. Inputs: user affect estimate, conversation events, time of day, memory triggers. Outputs: expression weights, gesture bias, gaze policy, TTS hint, and a two-line "how you feel" injection into the LLM system context. The LLM can also emit `[emote:x]` tags, which become events. See RESEARCH §9.

## ADR-13 Agent workflow

See `docs/WORKFLOW.md`. Main AI (Claude Code or DeepSeek) does research, planning, architecture, code review and any change touching `packages/core` interfaces. Aider (Kimi K2.7 code via Ollama cloud, launched with `--no-auto-commits --no-dirty-commits`) executes scoped briefs written by the main AI. Main AI audits Aider's diff before committing. Main AI commits after each completed task; Aider never commits.
