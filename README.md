# latentAura

A conversational AI you talk to face to face. A realistic-styled, full-body character lives in a small 3D set and joins you in a video call: you speak or type, it listens, reacts, and answers in voice with matching expression and body language. It remembers you, helps you brainstorm and plan, answers from your own documents and databases, and can run your smart home through Home Assistant.

**Status: planning.** No code yet. See `PROJECT.md` for where things stand.

## Principles

- **We ship no models.** Bring your own: Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, NVIDIA, Anthropic, OpenAI, or in-browser models you download yourself.
- **Browser-first.** The whole thing runs as a static web page in Chrome or Edge. A desktop app and an optional local companion add power features.
- **Your data stays yours.** Memory lives in your MariaDB (or SQLite, or the browser). No telemetry.
- **Open.** Permissive licence, permissive dependencies, CC0 assets.

## How it will work

```
mic / text ──▶ VAD + turn detection ──▶ STT ──▶ LLM (+ tools, memory) ──▶ TTS ──▶ speaker
                      │                                   │                 │
                      ▼                                   ▼                 ▼
               user affect (voice, text, face)      affect engine      lip sync + gestures
                                                          │
                                                          ▼
                                             full-body VRM character in a 3D set
```

- Conversation core and memory kernel: TypeScript, runs in the browser.
- Companion (optional): Rust service for MariaDB vector memory, document indexing, MCP tools.
- Avatar: three.js + VRM 1.0, procedural micro-motion, CC0 animation clips, optional NVIDIA Audio2Face.

## Documents

| Doc | What |
|---|---|
| `docs/RESEARCH.md` | Landscape, options, recommendations |
| `docs/DECISIONS.md` | Architecture decisions |
| `docs/PLAN.md` | Phased plan for humans |
| `docs/LLM-PLAN.md` | Task-level plan for agents |
| `docs/WORKFLOW.md` | Session ritual and agent hand-offs |
| `docs/brainstorm.md` | The original idea |

## Licence

To be decided (Apache-2.0 or MIT). Until a `LICENSE` file exists, all rights reserved.
