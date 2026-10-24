# latentPresence

**A companion you talk to face to face.** A full-body character joins you in what feels like a
video call: you speak or type, she listens, reacts and answers out loud, with expressions,
gestures and lip sync. She remembers you between visits, plans things with you, reminds you when
you ask, looks things up in your own notes and documents, and can run your smart home through
Home Assistant.

You choose the AI model that does the thinking. It can run on your own computer or be a cloud
service you already use. latentPresence ships no models, sends nothing to us, and collects no
telemetry.

<img width="2395" height="1331" alt="Screenshot 2026-10-24 121004" src="https://github.com/user-attachments/assets/4f9509a3-555c-4dc6-8fc3-9585f595da5e" />


> **Early release (0.2).** latentPresence works and is used daily, but it is young: expect rough
> edges, and please [open an issue](https://github.com/rickmcelvana/latentPresence/issues) when you
> hit one.

## Get it

### Windows app (recommended)

1. Download `latentPresence_x.y.z_x64-setup.exe` from the
   [latest release](https://github.com/rickmcelvana/latentPresence/releases/latest).
2. Run it. The installer is not code-signed yet, so Windows SmartScreen will say "Windows protected
   your PC": choose **More info → Run anyway**. It installs for your user only, no administrator
   needed.
3. A short setup walks you through choosing a model, showing the character, her voice and your
   microphone, where she keeps her memory, and your home, notes and documents. Every step can be
   skipped and changed later in Settings.

The app keeps itself up to date when you ask it to: **Settings → This app → Check for updates**.

### In your browser

Open **[app.latentpresence.com](https://app.latentpresence.com)** in Chrome or Edge. Everything
runs in the page, and what she remembers stays in your browser. Talking out loud needs WebGPU,
which Chrome and Edge have and most other browsers do not yet; typing works anywhere.

macOS and Linux have no app yet. On those, use the browser, and build the companion from source if
you want its extras (below).

## What you need

**A language model.** Pick one in setup or in Settings → Language model, and press Test:

- **On your own computer:** [Ollama](https://ollama.com), [LM Studio](https://lmstudio.ai),
  llama.cpp or vLLM.
- **In the cloud, with your own key:** OpenRouter, DeepSeek, Kimi, NVIDIA NIM, Ollama Cloud,
  Anthropic, Google, or any OpenAI-compatible endpoint.

Keys are kept in Windows Credential Manager in the app, or encrypted in your browser on the web.
They go only to the service they belong to.

**Her voice and hearing** run on your own computer by default. The first time, a consent screen
shows exactly what will be downloaded, how big it is, its licence and where it comes from, and
nothing downloads until you agree. You can instead point her voice or hearing at a server of your
own (any OpenAI-compatible speech endpoint).

**A graphics card helps.** Speaking with her uses your GPU for the voice models and the 3D
character. A recent integrated GPU works, and a dedicated one is smoother.

<!-- Screenshot: the setup wizard's model step. Suggested file: docs/images/setup.png -->

## What she can do

- **Talk, in voice or text.** She waits for you to finish your thought, can be interrupted, and
  answers with expression, gestures and lip sync. She reads the mood in your words and voice, and
  your face too if you turn on face reading. The camera is off unless you turn it on, and no frame
  ever leaves your computer.
- **Remember you.** She remembers facts, past conversations and her own notes across visits.
  Memory lives in your browser or app, or in a MariaDB database you run (a database address in
  setup is all it takes). The Memory panel shows what she remembers about you, and lets you
  correct or forget any of it.
- **Keep a schedule.** Ask "remind me Thursday at 9 to call the vet" and she reads the time back,
  then tells you when it comes due: as a Windows notification if you are away, or out loud if you
  are there.
- **Plan with you, and speak up.** She tracks plans and follow-ups, and when you come back after a
  while she may start the conversation. How often she checks in is a setting, and it can be off.
- **Use tools, with your permission.** Home Assistant (lights, sensors, scenes), folders of notes
  she may read, documents she can search and cite, a read-only database, web search, and any MCP
  server you add. Each tool asks before it acts until you tell it otherwise.
- **Two characters, or your own.** Alice and Theo each have their own memories and voice. Either
  can wear a `.vrm` model you provide, swapped live in the Body panel.
- **Stay in the tray.** In the Windows app, closing the window keeps her running by the clock, so
  reminders still arrive. "Small window, always on top" keeps her in a corner of your screen.

<!-- Screenshot: Settings → On this computer, or the Schedules panel. Suggested file: docs/images/settings.png -->

## Your data

- **No telemetry, no accounts, no server of ours** in the conversation. Requests go only where you
  pointed them: your model, your speech server, your tools.
- **Everything she remembers is yours**: in your browser, your app's storage, or your own database.
  Forget anything from the Memory panel.
- **Nothing is downloaded without asking.** Every model download shows its size, licence and source
  first.
- **Updates are checked only when you ask**, unless you turn on "Check for updates when the app
  starts". A check asks GitHub, where the releases live, and nothing else.

## The companion

The Windows app includes a small local service, the *companion*, that adds the things a web page
cannot do by itself:

- memory in your MariaDB database;
- Home Assistant and your folders of notes;
- document search;
- web search and read-only databases;
- reminders that fire even with the window closed.

In the app you set all of these up under **Settings → On this computer**. Nothing needs editing by
hand.

In the browser, the companion is optional and comes from source (`pnpm companion`, see below). The
first time the website reaches it, your browser asks whether
`app.latentpresence.com` may reach apps on your device: choose **Allow**. Then enter the companion's
pairing code, printed when it starts, under Settings → Companion.

## Troubleshooting

- **"Windows protected your PC"** when installing: the installer is unsigned. Choose **More info →
  Run anyway**.
- **Ollama works in the app but not on the website:** Ollama only answers web pages it was told
  about. Set `OLLAMA_ORIGINS=https://app.latentpresence.com` and restart Ollama. Settings →
  Language model → Test shows the steps for your system.
- **LM Studio from the website:** turn on "Enable CORS" in LM Studio's server settings.
- **The website says your browser is blocking it:** in Chrome or Edge, click the icon at the left
  of the address bar → Site settings → **Apps on device** → Allow. In Firefox, clear the block on
  **Device apps and services**. Then reload.
- **No voice in the browser:** use Chrome or Edge, which have WebGPU.

## Characters

Alice and Theo wear a placeholder model until you give them your own: any VRM 1.0 file, added in
the Body panel.

**Made your character in Daz 3D or Character Creator?**
[ccdz2vrm](https://github.com/rickmcelvana/ccdz2vrm) turns a Daz 3D (Genesis 3, 8 or 8.1) or
Character Creator 3+ export into a VRM 1.0 avatar that blinks, talks, makes expressions, with eyes that
follow. Use it in your browser at
**[ccdz2vrm.latentpresence.com](https://ccdz2vrm.latentpresence.com)**, or get the Windows app from
its [latest release](https://github.com/rickmcelvana/ccdz2vrm/releases/latest). It runs on your
own machine, and your character never leaves it. Its **Web** quality (3–8 MB) is the one to pick
for latentPresence.

## Building from source

Requires Node 22+, pnpm 12+ and a stable Rust toolchain with `rustfmt` and `clippy`.

```bash
pnpm install
pnpm dev          # the web app at http://localhost:5173
pnpm companion    # the companion, for the browser
pnpm desktop:build  # the Windows app and its installer
pnpm gate         # every check CI runs: types, lint, tests, build, Rust
```

The companion keeps its memory in MariaDB 11.8 or newer: copy `.env.example` to `.env` and set
`DATABASE_URL`, or enter the address in the app. How the project is built and decided is in
[`docs/`](docs): [`DECISIONS.md`](docs/DECISIONS.md) for the architecture,
[`PLAN.md`](docs/PLAN.md) for the roadmap, [`release.md`](docs/release.md) for releases.
Contributions are welcome: open an issue first for anything large.

## Licence

latentPresence is [Apache-2.0](LICENSE) (see also [NOTICE](NOTICE)). The models you download and
the character files carry their own licences, which are shown before anything is downloaded. The
placeholder character is pixiv's [three-vrm](https://github.com/pixiv/three-vrm) sample model,
under the VRM Public License 1.0.
