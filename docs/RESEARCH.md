# latentPresence — Research

Status: first pass 2026-09-07, recommendations accepted by Rick the same day (see `docs/DECISIONS.md`). Update when research changes.

Scope reminder from `docs/brainstorm.md`: conversational AI with a realistic-styled, full-body avatar in a video-chat framing; voice or text in, voice out; emotion sensing; memory in MariaDB; brainstorm and plan storage; document and database grounding; smart home; bring-your-own AI; open-source friendly; **we ship no models**.

---

## 1. What already exists (and why we are not just forking it)

| Project | Stack | Strong at | Gap vs latentPresence |
|---|---|---|---|
| [AIRI](https://github.com/moeru-ai/airi) (MIT, ~45k stars, v0.11 in 2026) | Vue, three-vrm, WebGPU, Electron (migrated off Tauri) | Browser-native VTuber companion, voice chat, game play, mobile | Anime/VTuber aesthetic and streamer framing; no MariaDB, no RAG over your documents, no affect model driving body, voice and wording together |
| [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) | Python backend + web client, Live2D | Offline voice loop, interruptions, vision, tools | Live2D (proprietary Cubism SDK), 2D, Python-centric, v2 rewrite pending |
| [Amica](https://github.com/semperai/amica) | Next.js, three-vrm, transformers.js | VRM companion with an emotion engine, in-browser Whisper and VAD | Small team, generic companion framing, no structured memory, planning or knowledge stack |
| [OpenAvatarChat](https://github.com/HumanAIGC-Engineering/OpenAvatarChat) + [LAM](https://github.com/aigc3d/LAM) | Python, WebGL | Photoreal one-shot Gaussian **head** avatars rendering in real time on the web | Head only, Python server required, research code |
| Replika, Kindroid, Nomi, Character.AI, Sesame, Hume EVI | Proprietary | Polished emotional voice | Closed, cloud only, no BYO models, no data ownership |

Takeaway: "VRM avatar + local LLM + voice" is a solved, crowded loop. latentPresence should not compete on that loop alone. Its distinct territory is **realistic full-body presence in a lived-in set, one affect model that drives face, body, voice and wording, a serious memory/planning/knowledge layer on MariaDB, and everything BYO and open**. See section 9.

We will still learn from AIRI and Amica (both MIT) for specific mechanics: VRM expression mapping, transformers.js pipelines, provider abstraction. We do not fork them because their architecture (Vue/Electron, Next.js) and framing differ, and a fork carries their aesthetic decisions.

---

## 2. Avatar: the central bet

### 2.1 Options considered

| Approach | Realism | Full body | Runs in browser | Open | Verdict |
|---|---|---|---|---|---|
| **3D VRM humanoid in three.js** ([three-vrm](https://github.com/pixiv/three-vrm) v3.x, VRM 1.0 + VRMA animation) | Stylized to semi-realistic (PBR materials allowed) | Yes | Yes (WebGL/WebGPU) | MIT | **Primary** |
| Gaussian-splat head (LAM) | Photoreal | Head/bust only | Yes (WebGL SDK exists) | Code Apache-2.0 (verify weights) | Later, as a renderer plugin |
| Full-body Gaussian avatars (TaoAvatar, SqueezeMe, HUGS, WebGPU 3DGS) | Photoreal | Yes | Emerging (WebGPU + ONNX skinning demos) | Research licences, SMPL-X is non-commercial | Watch list, not a base |
| Neural talking-head video (LivePortrait, MuseTalk, EchoMimic, Hallo) | Photoreal | Bust at best | No (GPU server) | Mixed | No: latency, GPU cost, no body |
| Unreal MetaHuman | Photoreal | Yes | No | Epic licence, Unreal only | No |
| Live2D | Stylized 2D | No | Yes | Cubism SDK proprietary | No |

### 2.2 Recommendation

A **semi-realistic full-body VRM 1.0 character** rendered with three.js, standing or sitting in a 3D set, framed like a video call. This is the only path that is simultaneously open, full body, real time in a browser, and fully controllable (gaze, expression, gesture, posture) from our affect engine. Photorealism in real time on the web is not there yet for full bodies. We design the renderer as a plugin so a LAM head or a splat body can be swapped in later without touching the conversation engine.

"Realistic styled" is achievable by controlling the asset: PBR skin, hair and cloth instead of MToon, realistic proportions, subtle animation. The uncanny valley is mostly an animation problem, not a mesh problem. We spend effort on micro-motion (breathing, blinks, saccades, weight shifts, head nods on prosody) rather than chasing polygon realism.

### 2.3 Character production pipeline (Rick's tools + open tools)

1. Concept and turnaround via image generation.
2. Mesh from image via a 3D mesh generator (Hunyuan3D or Tripo class) or sculpt.
3. Rig: [UniRig](https://github.com/VAST-AI-Research/UniRig) (SIGGRAPH 2025, open, auto skeleton and skin weights) or Blender Rigify. Commercial fallback: Auto-Rig Pro (one-time purchase; the produced assets remain ours).
4. Face: ARKit 52 blendshapes generated in Blender via [ARKit Blendshape Helper](https://github.com/elijah-atkins/ARKitBlendshapeHelper) (open) or ShapeKeyGen (paid), then hand-tuned.
5. Export VRM 1.0 with the Blender VRM add-on. Map ARKit shapes to VRM expressions and keep the raw ARKit shapes for Audio2Face and MediaPipe driving.
6. Animation: [Quaternius Universal Animation Library](https://quaternius.com/) (CC0, 250+ clips) retargeted to VRM. Mixamo clips may be used locally but must not be redistributed in the repo. [Mesh2Motion](https://mesh2motion.org/) is an open retarget tool.

Output: a repeatable pipeline in `docs/pipeline/character.md` (Phase 7) so others can bring their own character.

Division of labour (ADR-18): the architect generates concept and turnaround images through the ComfyUI connected to Claude Code (comfy-mcp) and writes exact instructions for each later step. Rick runs the mesh, rig and blendshape tools. The default character is Alice.

### 2.4 Lip sync and facial animation

| Layer | Tool | Runs where | Licence | Notes |
|---|---|---|---|---|
| Baseline | [wawa-lipsync](https://github.com/wass08/wawa-lipsync) | Browser, Web Audio | MIT | Real-time visemes from any audio source, zero server |
| Phoneme-accurate | TTS phoneme or word timestamps (Kokoro via misaki, Piper) | Browser | Apache/MIT | Better than amplitude-based when the TTS exposes timing |
| Premium | [NVIDIA Audio2Face-3D](https://github.com/NVIDIA/Audio2Face-3D) (open-sourced 2025, SDK + models on HF) | Companion process, NVIDIA GPU | SDK permissive, weights NVIDIA Open Model Licence | 52 blendshapes + Audio2Emotion from audio. Optional, never bundled |
| Alternative | LAM Audio2Expression (ONNX) | Browser | Verify | Lightweight audio to blendshapes |

### 2.5 Body and gesture

- Procedural layer (always on): breathing, blinking with saccades, gaze toward camera or user with natural drift, micro weight shifts, listening nods keyed to user prosody, "thinking" look-away.
- Clip layer: CC0 idle, talk, listen and gesture clips blended by affect state.
- Semantic layer: the LLM emits lightweight inline tags (`[gesture:shrug]`, `[emote:smile]`); the engine strips them before TTS and schedules them at word timestamps.
- Future: streamable co-speech gesture generation ([LiveGesture](https://arxiv.org/abs/2604.10927), April 2026) once weights and a permissive licence exist.

---

## 3. Speech stack (all BYO, nothing bundled)

### 3.1 Speech-to-text

| Runs where | Options |
|---|---|
| In browser | [Moonshine](https://huggingface.co/posts/Xenova/486935205804807) tiny/base (MIT, ~50 MB, WebGPU/WASM via transformers.js), Whisper via transformers.js |
| Local server | whisper.cpp, faster-whisper, NVIDIA Parakeet, Kyutai STT (streaming), Qwen3-ASR |
| Cloud (BYO key) | Any OpenAI-compatible `/audio/transcriptions`, Deepgram, and similar |

### 3.2 Text-to-speech

| Runs where | Options | Emotion control |
|---|---|---|
| In browser | [Kokoro 82M](https://www.npmjs.com/package/kokoro-js) (Apache-2.0, WebGPU, streaming forks exist), Kyutai Pocket TTS (100M, CPU real time, Jan 2026, verify licence) | Voice choice and speed only |
| Local server | Kokoro-FastAPI, Chatterbox (MIT, exaggeration control), Orpheus (Apache, tag-style emotion), CosyVoice2 (150 ms streaming, instruct emotion), IndexTTS-2 (independent emotion and timbre), Kyutai TTS 1.6B (streaming), Fish Speech | Yes, varies |
| Cloud (BYO key) | OpenAI, ElevenLabs, Cartesia, Hume | Yes |

Design: a `TTSProvider` interface with capability flags (`streaming`, `wordTimestamps`, `emotionHints`, `styleTags`). The affect engine sends an emotion hint; each adapter maps it to whatever the backend supports (tag, instruct text, speed, or nothing).

### 3.3 Turn-taking, interruption, flow

- VAD: Silero VAD in the browser (onnxruntime-web), the de facto standard.
- End of turn: [Pipecat Smart Turn v3](https://huggingface.co/pipecat-ai/smart-turn-v3) (BSD-2, ONNX, CPU under 100 ms, audio-based, 23 languages) or [LiveKit turn-detector](https://huggingface.co/livekit/turn-detector) (open weights, transcript-based). Spike: run Smart Turn v3 in onnxruntime-web. Fallback: VAD silence timer with adaptive thresholds.
- Barge-in: user speech during playback fades TTS within ~100 ms, cancels the LLM stream, and records what was actually heard (transcript truncated at the interruption point).
- Backchannels: pre-synthesised "mm-hm", "right", breaths, played in user pauses below the end-of-turn threshold, gated by affect state.
- Latency target: first audio under 800 ms after end of turn (streaming LLM, sentence splitter, streaming TTS, audio queue).
- Reference architectures: [Kyutai Unmute](https://github.com/kyutai-labs/unmute) (modular STT/LLM/TTS, low latency), Pipecat, LiveKit Agents. We borrow the pipeline shape, not the Python.

### 3.4 Audio-native and speech-to-speech models

Qwen3-Omni and Qwen3.5-Omni (open, audio in and speech out, tone-aware), Ultravox, Voxtral, Moshi, Sesame CSM. These hear tone directly. We support them through an optional `OmniProvider` path (audio in, text and audio out) but keep the cascaded pipeline as the default because it works with any text LLM, including Nemotron 3 through NVIDIA's OpenAI-compatible endpoint.

---

## 4. LLM connectivity

- Universal interface: OpenAI-compatible chat completions. Covers Ollama, LM Studio, vLLM, llama.cpp server, OpenRouter, NVIDIA `https://integrate.api.nvidia.com/v1` (Nemotron 3 Nano, Super, Ultra and Nemotron 3.5), DeepSeek, Kimi.
- Native adapters where it matters: Anthropic (prompt caching, extended thinking), Google.
- Harness: [Vercel AI SDK 6](https://vercel.com/blog/ai-sdk-6) (Apache-2.0, TypeScript): streaming, tool calling, structured output, MCP client with OAuth, resources, prompts and elicitation. Runs in browser and Node. Chosen over LangGraph, Mastra and Pydantic AI to keep the core in TypeScript and browser-runnable.
- Browser-only mode: requests go straight from the page to the user's endpoint. Local servers need CORS enabled (`OLLAMA_ORIGINS`, LM Studio CORS toggle). The onboarding wizard explains this per backend.

---

## 5. Emotion sensing

| Channel | Tool | Runs where |
|---|---|---|
| Text (words, emoji, punctuation, pace) | The LLM itself with a structured "user affect" side output, plus a tiny heuristic emoji and punctuation scorer for instant reactions | Browser |
| Voice prosody | [emotion2vec+](https://huggingface.co/emotion2vec) (MIT, ~19M params, 9 classes, needs ONNX export) or [wav2vec2 SER ONNX](https://huggingface.co/onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX) | Browser (onnxruntime-web) |
| Face (opt-in camera) | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js), 52 blendshapes into valence and arousal heuristics plus smile, brow and gaze features | Browser, Apache-2.0 |
| Audio-native LLM | Qwen3-Omni class | Optional server |

All channels fuse into one `UserAffect` estimate (valence, arousal, confidence, dominant label) consumed by the affect engine and injected into the LLM context as one short structured line, never as raw video.

---

## 6. Memory and MariaDB

- [MariaDB 11.8 LTS](https://mariadb.org/projects/mariadb-vector/) has native `VECTOR(N)` columns, HNSW `VECTOR INDEX`, `VEC_DISTANCE_COSINE` and `VEC_DISTANCE_EUCLIDEAN`, up to 16,383 dimensions. One database serves relational data and vector search. No separate vector store.
- Memory frameworks reviewed: mem0 (vector extract-and-retrieve), Zep/Graphiti (bi-temporal knowledge graph, best on LongMemEval), Letta (self-editing memory blocks). All are Python services. Bringing one in would make Python a core dependency and would fight the "MariaDB is the store" goal.
- Recommendation: a **TypeScript memory kernel** behind a `MemoryStore` adapter interface. Primary adapter is MariaDB through the Rust companion; fallbacks are SQLite (desktop) and IndexedDB (web-only). The design borrows the best of each framework:
  - Episodic: turn log with embeddings and session metadata.
  - Semantic facts: subject, predicate, object with `valid_from` and `valid_to` (bi-temporal, Graphiti style) so "I moved" supersedes rather than contradicts.
  - Self-model and persona blocks the agent can edit with tools (Letta style), including current mood.
  - Plans and brainstorms: structured documents (title, goal, phases, tasks, status) with versions.
  - Consolidation job ("sleep"): when idle, summarise episodes into facts, decay stale facts, dedupe.
- Embeddings are BYO (Ollama `nomic-embed-text` or `bge-m3`, OpenAI, or in-browser via transformers.js). Dimension is stored per collection; changing the embedding model triggers a re-index.
- Postgres with pgvector was considered since it also runs on Rick's server. It would work equally well. MariaDB stays because its vector support is native (no extension), Rick prefers it, and one adapter is enough for v1 (ADR-05).
- The development MariaDB is remote (Canada, over a tunnel), so every retrieval pays a WAN round trip. The kernel therefore batches retrieval into one call per turn, caches self-model blocks and recent turns in process, and never blocks the speaking path on a write (ADR-17). SQLite via `sqlite-vec` is the zero-setup fallback for users without a database.

---

## 7. Knowledge grounding and tools

- MCP is the tool standard; the AI SDK MCP client connects to any server. First-party MCP servers run in the companion: MariaDB memory and plans, document search, read-only SQL against user-registered databases (schema introspection, query preview, execution behind a confirm step), scoped filesystem.
- Document ingestion in the companion (Rust): PDF, Markdown, DOCX, HTML, TXT into chunks, BYO embeddings, MariaDB vectors. Answers cite chunks; citations render on an in-world screen.
- Web search: SearXNG (self-hosted, open) or Brave and Tavily with BYO key. Browser automation: Playwright MCP.
- Smart home: [Home Assistant's built-in MCP server](https://www.home-assistant.io/integrations/mcp_server/) exposes devices, areas and intents as tools. Home Assistant already bridges to Google Home and Alexa, so we get both without writing proprietary skills. Direct Alexa or Google skill development is deferred indefinitely.

---

## 7b. Scheduled tasks

Users will want "do this later" and "do this every morning": reminders, nightly re-indexing, a morning briefing from a notes folder, a Home Assistant routine with judgement in it. Existing companions mostly lack this; assistants that have it (cloud) run the job on their servers. Our constraint is that the core runs in the browser, so the job runs wherever the core is alive: the open tab, or the desktop app in tray mode. Missed jobs are reconciled on wake with a per-job catch-up policy. Tool-only jobs can be delegated to the companion so they run with the app closed. Every schedule is visible and cancellable, and the character confirms new schedules aloud so nothing is created silently. Design in ADR-14; tasks P6-T07, P6-T08, P8-T05.

## 8. Platform and language

### 8.1 What AIRI learned the hard way

AIRI adopted Tauri early, then spent three months fighting WebKit (macOS WKWebView) and the Web Audio API for voice chat, and migrated to Electron in October 2025. On Windows, Tauri uses WebView2 (Chromium), which is fine. The pain is macOS and iOS WebKit and Linux WebKitGTK (WebGPU, AudioWorklet and WebCodecs gaps).

### 8.2 Recommendation

- **Browser-first.** The full experience must run in Chrome or Edge (WebGPU, AudioWorklet, WebCodecs) as a static site. This also gives us the hosted "bring your own AI" web version for free.
- **Rust companion** (`latentpresence-companion`): a headless local process (axum, tokio, sqlx/mysql) that any browser talks to over localhost. It provides MariaDB access, document indexing, the MCP host, an optional Audio2Face bridge and optional local model proxies. It is "power mode" and works with the hosted web app, a local static build, or the desktop shell.
- **Desktop shell is Tauri 2, Windows first** (Rick's decision 2026-09-07). WebView2 is Chromium so the browser-first build runs unchanged. Linux gets a spike on Rick's Linux box (WebKitGTK is the risk). macOS is deferred: no hardware, and WebKit is where AIRI failed. Electron stays a documented fallback. Because the product is browser-first, catching other platforms up later is packaging work, not product work.
- Language split: TypeScript for everything user-facing and for the conversation core (must run in the browser). Rust for the companion. No Python in the core. Python is allowed only in external BYO model servers the user runs anyway.
- Frontend: Vite, React, react-three-fiber + drei, @pixiv/three-vrm, zustand, Web Workers for ML (transformers.js, onnxruntime-web). Monorepo with pnpm workspaces, Biome for lint and format, Vitest, Playwright for end-to-end.

Why not Bevy and WASM: three-vrm and the whole avatar and animation ecosystem are JavaScript. Bevy's WASM story for audio and ML is immature. We would rebuild everything.

---

### 8.3 Hosting and site

Same shape as the other latent apps: `latentpresence.com` is a static site (landing, docs, feedback form posting to `/api/feedback` through Caddy to the existing feedback API with `source: "presence"`), and `app.latentpresence.com` serves the `apps/web` build. The hosted app reaches local services (companion, Ollama, LM Studio) because browsers exempt `localhost` from mixed-content blocking; Chrome's Local Network Access rules add a preflight header requirement and a one-time permission prompt, which the companion and the onboarding copy must handle (ADR-16, P8-T03). Design tokens are shared with latentbeats.com, with a teal accent for this product (ADR-15).

## 9. Differentiators to build (accepted 2026-09-07)

1. **Affect Engine as the single source of truth.** A persistent mood (pleasure, arousal, dominance plus discrete emotion events with decay) drives face, posture, gesture selection, TTS style hints, response length and wording. Mood persists across sessions in MariaDB. Most projects bolt an emoji onto an expression; we make body, voice and words agree.
2. **A lived-in set with diegetic UI.** The character lives in a room. Time of day tracks the user's clock; weather comes from a tool. Brainstorms appear on a whiteboard, search results on a screen, memories in a notebook. The video-call framing keeps the camera on the character while tools happen in the world.
3. **Presence loop.** Idle life (reads, stretches, looks out the window), proactive but rate-limited check-ins, a sense of elapsed time ("it has been a week"), and an idle "sleep" that consolidates memory. A private inner-monologue channel the user can optionally peek at.
4. **Bidirectional emotion.** The character reads the user's voice, text and (opt-in) face and reacts in real time, including backchannels while the user is still speaking.
5. **Planning studio.** "Let's plan X" produces structured plans stored in MariaDB, editable in a side panel, exportable to Markdown. The character remembers and follows up.
6. **Knowledge grounding with visible citations** from the user's own documents and databases.
7. **Radically BYO and open.** No models shipped. A model registry shows each model's licence. Providers for browser, local server and cloud. Works from a static web page.

Ethics note for the "conscious-seeming" goal: we design for presence and continuity, not deception. The character never claims to be human when sincerely asked. Attachment-exploiting patterns (guilt, scarcity, manufactured jealousy) are out of scope. A visible "this is an AI" affordance lives in settings. This keeps the project shareable.

---

## 10. Licensing summary

Code: MIT or Apache-2.0 (Rick to choose; recommendation is Apache-2.0 for the patent grant, MIT if we want parity with three-vrm and AIRI). All core dependencies are MIT, Apache or BSD. Models are downloaded by the user at runtime from Hugging Face or run on the user's own servers; each has its licence displayed in the registry. Optional paid tools (Auto-Rig Pro, ShapeKeyGen) affect only the asset pipeline, and the resulting assets can be released under our terms. Mixamo clips are usable but not redistributable; the repo ships CC0 clips only.

---

## 11. Open risks

| Risk | Mitigation |
|---|---|
| Uncanny valley with a semi-realistic body | Invest in micro-motion; offer a stylisation slider; keep stylised VRM characters supported |
| In-browser ML pressure (VAD, STT, TTS, SER, face tracking, 3D at once) | Workers, WebGPU, quality tiers, and a "companion does the heavy lifting" mode |
| Smart Turn v3 may not run in onnxruntime-web | Fallback to adaptive VAD timers; run it in the companion |
| Tauri on macOS and Linux WebKit | Browser-first, spikes in Phase 0, Electron as documented fallback |
| MariaDB is heavy for casual users | Companion can also use SQLite; MariaDB is recommended, not required |
| Kokoro-class in-browser TTS lacks emotion | Emotion via prosody hints (speed, pauses) plus expressive backends when available |

---

## Sources

- AIRI: https://github.com/moeru-ai/airi, migration devlog https://airi.moeru.ai/docs/en/blog/DevLog-2025.10.20/
- Open-LLM-VTuber: https://github.com/Open-LLM-VTuber/Open-LLM-VTuber
- Amica: https://github.com/semperai/amica
- LAM and OpenAvatarChat: https://github.com/aigc3d/LAM, https://github.com/HumanAIGC-Engineering/OpenAvatarChat
- three-vrm: https://github.com/pixiv/three-vrm, VRMA https://vrm.dev/en/vrma/
- wawa-lipsync: https://github.com/wass08/wawa-lipsync
- NVIDIA Audio2Face-3D: https://github.com/NVIDIA/Audio2Face-3D, https://huggingface.co/nvidia/Audio2Face-3D-v3.0
- UniRig: https://github.com/VAST-AI-Research/UniRig
- ARKit Blendshape Helper: https://github.com/elijah-atkins/ARKitBlendshapeHelper
- Quaternius and Mixamo alternatives: https://app.cinevva.com/guides/free-character-animations-rigging
- Full-body Gaussian avatars: https://arxiv.org/pdf/2503.17032, https://www.emergentmind.com/topics/webgpu-powered-gaussian-splatting
- LiveGesture: https://arxiv.org/abs/2604.10927
- Kokoro-js: https://www.npmjs.com/package/kokoro-js, https://github.com/rhulha/StreamingKokoroJS
- Moonshine web: https://huggingface.co/posts/Xenova/486935205804807
- Open TTS roundups 2026: https://www.bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models
- Kyutai Unmute, TTS, STT: https://github.com/kyutai-labs/unmute, https://kyutai.org/tts/
- Smart Turn v3: https://huggingface.co/pipecat-ai/smart-turn-v3, https://github.com/pipecat-ai/smart-turn
- LiveKit turn detector: https://huggingface.co/livekit/turn-detector
- Qwen3-Omni: https://github.com/QwenLM/Qwen3-Omni, Qwen3.5-Omni https://qwen.ai/blog?id=qwen3.5-omni
- emotion2vec: https://huggingface.co/emotion2vec, wav2vec2 SER ONNX https://huggingface.co/onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX
- MediaPipe Face Landmarker web: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- MariaDB Vector: https://mariadb.org/projects/mariadb-vector/, https://mariadb.com/docs/server/reference/sql-structure/vectors/vector-overview
- Memory frameworks compared: https://www.digitalapplied.com/blog/open-source-agent-memory-mem0-letta-zep-compared
- Vercel AI SDK 6 and MCP: https://vercel.com/blog/ai-sdk-6, https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- Home Assistant MCP server: https://www.home-assistant.io/integrations/mcp_server/
- NVIDIA Nemotron via OpenAI-compatible API: https://docs.openclaw.ai/providers/nvidia, https://openrouter.ai/nvidia
- Tauri 2 and WebGPU: https://github.com/tauri-apps/tauri/issues/6381, https://v2.tauri.app/reference/webview-versions/
- Aider and Ollama: https://aider.chat/docs/llms/ollama.html; Kimi K2.7 code on Ollama cloud https://github.com/ollama/ollama/issues/17717
