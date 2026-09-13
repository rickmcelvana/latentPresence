# TASKS — the things that need a human or a live endpoint

Moved out of `PROJECT.md` on 2026-09-12 so each task can carry the command that does it.
`PROJECT.md` keeps a one-line pointer and the open count.

**How to use this file.** Every open task is one block: what it is, one command to run, what
a pass looks like, and what to paste back. Read the line, run it, report. Nothing here needs
you to work out *how*.

**Owners.**
- `claude` — I can run it from this repo. If it says **needs**, add that to `.env` and say go.
- `rick` — needs your hands, your hardware, or your judgement. Only these are really yours.

**Keys live in `.env`** (gitignored, never committed). `.env.example` lists every name with a
comment. A missing key makes a live check skip, never fail.

## Running the live checks

Neither is part of `pnpm gate` — they need endpoints, and a gate that depends on the
weather is not a gate. Both skip any target whose key is missing.

```bash
pnpm live:llm
```

```bash
pnpm live:tts
```

`live:tts` also writes playable WAVs to `packages/providers/live/out/` (gitignored),
re-encoded from what our own decoder produced — so if they sound right, the adapter is
right.

---

## Open — rick

### R-1 · Avatar frame rate on a different class of GPU
**Why:** every frame-rate number we have is from one RTX 5060 Ti. The interesting machine is
a worse one — a laptop, or anything with integrated graphics. Not urgent; nothing is blocked.

```bash
pnpm dev
```
Then open `http://localhost:5173/spike/avatar` on the other machine and let it run ~30 s.

**Expect:** the page prints a frame-rate table (median, 5th percentile, worst frame).
**Report:** paste the table plus the GPU name. `docs/spikes/B-vrm-lipsync.md` gets the row.

### R-2 · Hear the character speak, in the app
**Why:** the plan's done-when for P1-T05. **Blocked until P1-T08** builds the AudioWorklet
output queue — there is nowhere to play audio today. The server adapter is already verified
against real bytes (see D-4), so what is left is genuinely the play-out path.

**Nothing to run yet.** This unblocks when P1-T08 lands; the command will be added here then.

### R-3 · Character pipeline
**Why:** P7. **Blocked on me** — waiting for `docs/pipeline/character.md`, which I owe you.
Includes replacing `apps/desktop/src-tauri/icons/`, currently Tauri's scaffold logo.

---

## Open — claude (say go, or add the key)

### C-4 · Is the TTS server actually using the GPU?
**Why:** the `maxChars` measurement (D-7) says synthesis costs 15.3 ms per character, and
whether that is a GPU or a CPU number changes what the browser path should be expected to
do. Kokoro-FastAPI's debug endpoints are disabled here, so it cannot be read from outside.

**Run:** whatever you used to start it — check the startup log for the device it picked, or
re-run it with debug endpoints enabled.

**Expect:** a line naming `cuda` or `cpu`.
**Report:** paste it. One word settles whether the 15.3 ms/char figure is pessimistic.

### C-5 · Compare Kokoro `fp32` against `q8` for synthesis quality
**Why:** `fp32` is the default because Spike A measured it — 325 MB on first run against
86 MB for `q8`, and nobody has compared *synthesis* quality (Spike A's q8 finding was about
Moonshine recognition). Rick's answer to the old C-2: Kokoro-FastAPI cannot be pointed at a
q8 graph without structural change.

**It does not need a server.** `kokoro-js` runs in node, so both precisions can be loaded
directly and the same sentence synthesised twice for comparison — no KoboldCpp, no pykokoro,
no fork. **Needs:** a go, because it downloads ~410 MB from Hugging Face to this box
(86 MB q8 + 325 MB fp32).

---

## Done

Newest first. Each line is the outcome, not the instructions — the detail is in
`docs/SESSION-LOG.md` and the facts are in `docs/SURFACE.md`.

- **D-8 · Add Fable to the Anthropic catalog** — done 2026-09-12. `claude-fable-5-1` added
  with every flag live-confirmed rather than inherited: it answered a question about an
  image, accepted `cache_control`, reports `thinking_tokens`, and streams text and tool
  calls. `claude-fable-5` deliberately left out as a previous point release.
- **D-7 · Measure `maxChars`** — done 2026-09-12. **200 stays.** Synthesis is 15.3 ms/char
  with no per-request overhead and runs 3.8x faster than speech, so chunk length cannot
  starve playback, and the cap does not touch the opening at all — 120, 200 and 320 give an
  identical first chunk. The real lever is a separate cap on the *first* chunk of a turn,
  which belongs to P1-T08.
- **D-6 · Accept ADR-22, 23, 24** — done 2026-09-12. No `proposed` ADRs remain. ADR-23 still
  obliges P1-T12 to decide explicitly whether to promote the tag shape into the protocol.
- **D-5 · Gemini context length** — done 2026-09-12. `GET /v1beta/models` reports
  `inputTokenLimit` 1048576 for all three catalog models, so `contextLength` is no longer
  `null`. The value is 2^20, not the round million — which is why it was never guessed.
- **D-4 · TTS against a real server** — done 2026-09-12 against Kokoro-FastAPI. 72 voices,
  24 kHz WAV decoded by `wav.ts`, RTF 0.25–0.41, `speed` honoured, errors passed through
  verbatim. Model id is `kokoro`, not `kokoro_v1`.
- **D-3 · Anthropic context lengths** — done 2026-09-12. `max_input_tokens` confirms all
  three catalog values (1M / 1M / 200K). The undated `claude-haiku-4-5` alias resolves.
- **D-2 · Live LLM streaming with a BYO key** — done 2026-09-12, the done-when for P1-T02
  and P1-T03. Nine endpoints, text and tool calls, all correct. Found that a thinking model
  can spend its whole budget reasoning and say nothing.
- **D-1 · Phase 0** — every spike run and every go/no-go call made, closed 2026-09-11 by
  P0-T09. The detail is in `docs/spikes/` and the ADR amendments.

### Earlier, from the old PROJECT.md backlog

Feedback API `presence` source and the Caddy proxy · Caddy sites for both domains · the
tunnel and MariaDB 11.8 check for Spike C · the `/gallery` click-through · `/spike/turn`
(eight runs, go at 100 ms / 0.7) · ADR-21 accepted · `/spike/avatar` (120.5 fps median) ·
the 1080p reading (unchanged at 1916×1076) · `DATABASE_URL` in `.env` · MariaDB 11.8.8 at
`192.168.40.101` · raising `mhnsw_max_cache_size` to 2 GiB, which was the whole finding of
Spike C · Fedora Tauri prerequisites · the Spike E Windows shell (go on WebView2) · one tray
click, which found the AppUserModelID trap · `pnpm i -g pnpm@12` on Windows.
