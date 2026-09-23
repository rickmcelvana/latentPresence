# latentPresence W.I.P.

A conversational AI you talk to face to face. A realistic-styled, full-body character lives in a small 3D set and joins you in a video call: you speak or type, it listens, reacts, and answers in voice with matching expression and body language. It remembers you, helps you brainstorm and plan, runs tasks you schedule, answers from your own documents and databases, and can run your smart home through Home Assistant.

Site: https://latentpresence.com · App: https://app.latentpresence.com

**Status: Phase 2, avatar and stage — under way; Phase 1's last check still open.** A typed chat, a settings page and **voice on `/chat`** work today (P1-T15, 2026-09-22); Phase 1 closes on a five-minute spoken conversation (R-9) held from a real build by a person. In Phase 2 she arrived in `/chat` as a video call: a full-body character in a lit room who breathes, blinks, looks around, lip-syncs to her voice, stands in idle and talking animations (CC0, Quaternius), and shows the emotions and gestures the model writes — with a transcript drawer, mute, and your camera as a picture-in-picture. See `PROJECT.md` for the current task.

## Quick start

Requires Node 22+, pnpm 12+ and a stable Rust toolchain (`rustfmt` and `clippy` components).

```bash
pnpm install
pnpm gate
```

`pnpm gate` is the whole check, in the order CI runs it: `tsc -b`, oxlint, vitest, `vite build`,
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`. `pnpm gate:app` and `pnpm gate:rust`
run half each. `pnpm dev` starts the web app on Vite's dev server.

With `pnpm dev` running: `/settings` picks a language model (Ollama, LM Studio, cloud keys) and tests the connection; `/chat` talks to it. NVIDIA's API does not answer web pages, so it goes through the companion — start it with `pnpm companion` (ADR-29).

```
apps/web/            Vite + React 19 app, deployed to app.latentpresence.com
site/                static marketing site, docs and feedback form (P0-T03)
packages/protocol/   shared types and the companion API schema
packages/core/       conversation engine, affect engine, memory kernel, scheduler
packages/providers/  llm, stt, tts, embedding and omni adapters
packages/avatar/     three.js / VRM renderer, animation, lip sync, set
packages/ml-web/     worker wrappers for transformers.js and onnxruntime-web models
companion/           Rust workspace: the optional local service
docs/                research, decisions, plans, briefs, spikes
```

Copy `.env.example` to `.env` for the companion's `DATABASE_URL`. `.env` is never committed.

Deployment is a `git pull` on the server followed by `pnpm install --frozen-lockfile && pnpm build`;
Caddy serves `site/` and `apps/web/dist` straight out of the checkout (ADR-16).

## Principles

- **We ship no models.** Bring your own: LM Studio, vLLM, llama.cpp, Ollama, OpenRouter, NVIDIA, Anthropic, OpenAI, or in-browser models you download yourself after a consent screen that shows size and licence.
- **Browser-first.** The whole thing runs as a static web page in Chrome or Edge. A Windows desktop app and an optional local companion add power features.
- **Your data stays yours.** Memory lives in your MariaDB, or SQLite, or the browser. No telemetry.
- **Open.** Apache-2.0 code, permissive dependencies, CC0 assets.

## How it will work

```
mic / text ──▶ VAD + turn detection ──▶ STT ──▶ LLM (+ tools, memory, schedules) ──▶ TTS ──▶ speaker
                      │                                   │                          │
                      ▼                                   ▼                          ▼
               user affect (voice, text, face)      affect engine            lip sync + gestures
                                                          │
                                                          ▼
                                             full-body VRM character in a 3D set
```

- Conversation core, affect engine, memory kernel and scheduler: TypeScript, runs in the browser.
- Companion (optional): Rust service for MariaDB vector memory, document indexing, MCP tools.
- Avatar: three.js + VRM 1.0, procedural micro-motion, CC0 animation clips, optional NVIDIA Audio2Face.

## Documents

| Doc | What |
|---|---|
| `docs/RESEARCH.md` | Landscape, options, recommendations |
| `docs/DECISIONS.md` | Architecture decisions |
| `docs/PLAN.md` | Phased plan for humans |
| `docs/LLM-PLAN.md` | Task-level plan for agents |
| `docs/WORKFLOW.md` | Build loop, session ritual, agent hand-offs |

## Licence

Apache-2.0, see `LICENSE` and `NOTICE`. Assets carry their own licences, recorded alongside them.
