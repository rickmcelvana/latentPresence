# Spike E — the Tauri shell

**Status: both legs run.**
**Linux — no-go for Tauri.** `navigator.gpu` does not exist in WebKitGTK, so ADR-07's
existing fallback clause fires and Linux ships as "companion + Chrome".
**Windows — go.** WebView2 152.0.4191.66 provides a real WebGPU adapter, a live microphone,
AudioWorklet, WebGL 2 and a tray, so ADR-07's Windows-first path is confirmed as written.
One row is outstanding (a native notification raised from Rust), and it gates nothing.
Task P0-T08. Brief: `docs/briefs/P0-T08.md`. Verified surface facts: `docs/SURFACE.md`.

## The question

ADR-07 targets Tauri 2 with Windows first and names WebKitGTK as the risk in its own text.
It also pre-writes the answer: "if Tauri blocks a platform later, that platform ships as
`companion + Chrome/Edge`". So this spike needed no new decision — it confirms ADR-07's
Linux path or it triggers a clause ADR-07 already contains.

**Does Linux ship as a Tauri app, or as companion + Chrome?**

## The answer, in one row

```
| WebGPU (navigator.gpu) | NO | navigator.gpu is undefined — the port does not expose WebGPU at all |
```

Taken inside the Tauri window on Rick's Fedora 44 box, 2026-09-09. Not a namespace that
fails to find a device — the namespace is not there. Three Phase 0 results depend on
WebGPU: Spike A measured synthesis at 947 ms on WebGPU against **3779 ms on wasm**, Spike D
found Smart Turn's int8 build will not load on WebGPU at all and fp32/WebGPU is the go
configuration, and Spike B's 120.5 fps avatar wants a GPU path. Without it the Linux voice
pipeline is not slower than ADR-20's 500 ms budget, it is outside it by roughly seven
times, and no amount of shell engineering closes that.

**Linux ships as companion + Chrome.** ADR-07 amended with a dated note; no new ADR.

## The machine

Fedora Linux 44, GNOME 49 on **Wayland**, NVIDIA GeForce RTX 5060 Ti on the proprietary
driver **610.57.04** — the same hardware class as the Windows box, which is what makes the
comparison clean. `webkit2gtk4.1` **2.52.5** (`pkg-config --modversion webkit2gtk-4.1` →
`2.52.5`). Google Chrome **153.0.8010.36** as the control. rustc 1.98.0, Node 22.23.2.

## Capabilities, per container

Everything below is the same page — `/spike/shell`, `apps/web/src/spikes/capabilities.ts` —
printed by the page itself rather than transcribed. In the Tauri column it reaches the
terminal through the shell's one command; in the Chrome columns through the console.

| Capability | Tauri / WebKitGTK 2.52.5 | Chrome 153, as launched | Chrome 153, `--disable-gpu-sandbox` |
|---|---|---|---|
| WebGPU (`navigator.gpu`) | **NO** — undefined | yes | yes |
| WebGPU adapter | **NO** — nothing to ask | **NO** — `requestAdapter()` resolved null | **yes — `nvidia / blackwell`** |
| WebGL 2 | yes — renderer reported as `Apple GPU` | yes — `ANGLE (NVIDIA … RTX 5060 Ti …)` | yes — same |
| AudioWorklet | yes | yes | yes |
| getUserMedia (API present) | yes | yes | yes |
| Microphone (live) | **NO** — see the error below | prompt opened, unanswered | prompt opened, unanswered |
| SharedArrayBuffer | NO — `crossOriginIsolated = false` | NO — same | NO — same |
| Notification API | yes — `permission = default` | yes | yes |
| Tray | **not measured** — see "what this spike did not do" | n/a | n/a |
| Windows / WebView2 | **measured 2026-09-11 — own section below** | | |

`Apple GPU` in the WebKitGTK row is WebKit's deliberately masked renderer string, not a
detection failure and not a real device name. It means **this table cannot say whether
WebGL in the webview is hardware or software**, and given the GBM failures below the
honest reading is "unknown, probably not hardware". It did not matter enough to chase: the
WebGPU row had already decided the question.

## Results — Windows / WebView2, the second sitting (2026-09-11)

Same page, same `capabilities.ts`, same method: printed by the page through the shell's
`record` command rather than transcribed. **WebView2 runtime 152.0.4191.66**, Tauri 2.11.5,
Windows x86_64, on the RTX 5060 Ti box — the same hardware class as the Fedora machine,
which is what makes the two columns comparable.

| Capability | Tauri / WebView2 152.0.4191.66 | vs. Linux / WebKitGTK 2.52.5 |
|---|---|---|
| WebGPU (`navigator.gpu`) | **yes** | NO — undefined |
| WebGPU adapter | **yes — `nvidia / blackwell`** | NO — nothing to ask |
| WebGL 2 | yes — `ANGLE (NVIDIA … RTX 5060 Ti … D3D11)` | yes, but renderer masked as `Apple GPU` |
| AudioWorklet | yes | yes |
| getUserMedia (API present) | yes | yes |
| Microphone (live) | **yes** — `Default - Microphone (Arozzi Sfera Pro Microphone) (0d8c:016c)` | **NO** — `NotAllowedError` from wry |
| SharedArrayBuffer | NO — `crossOriginIsolated = false` | NO — same |
| Notification API | yes — `permission = denied`, but see below | yes — `permission = default` |
| Tray | **yes** — `tray: built`, icon in the notification area | not measured |
| Native notification (from Rust) | *outstanding — one tray click* | not measured |

**The adapter row is a real hardware pass, not a namespace.** `capabilities.ts` learned on
the Linux leg to call a software rasteriser a failure, so `nvidia / blackwell` here means
what it says. Nothing in Spike A, B or D is at risk on Windows.

**The microphone row is the sharpest contrast in the table.** Same wry, same
`getUserMedia`, opposite results: Linux got `NotAllowedError` from wry's default permission
handler with no prompt drawn, Windows opened the stream with no prompt either. Whatever wry
does with permission requests, it is platform-specific rather than a uniform default, and
P8-T02's first-run experience inherits that on both.

**`SharedArrayBuffer` is NO in every container measured** — WebKitGTK, WebView2, Chrome on
Linux and Chrome on Windows. Four containers agreeing locates it in the Vite dev server,
which sends no `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`, not in any
webview. It costs nothing in Phase 0 — every measured result is a WebGPU result — but
onnxruntime-web's *threaded* wasm build needs it, so **Spike A's 3779 ms wasm figure was
taken single-threaded** and the wasm fallback has never been measured with threads. On
Linux that fallback is now the shipping path, which makes it a Phase 1 question rather than
a curiosity.

### The Notification row carries a variable I introduced, and it is not clean

`permission = denied` on Windows against `default` on Linux, and the two runs are not
comparing the same object. The Windows shell registers `tauri-plugin-notification` (added
this sitting for the tray), and **that plugin polyfills `window.Notification` onto its own
IPC command** — so the page is reading the plugin's view of permission, not WebView2's. The
Linux run had no such plugin and read the webview's own.

What is known rather than guessed: with the plugin registered and the capability file
granting only `core:default`, a page calling `Notification.requestPermission()` — containing
no Tauri code at all — is refused by the ACL with

```
notification.request_permission not allowed. Permissions associated with this command:
notification:allow-request-permission, notification:default
```

and once `notification:default` is granted the same call returns `granted`. Both were
observed on Windows on 2026-09-11. `capabilities/default.json` now grants it.

`capabilities.ts` only *reads* `Notification.permission` and never requests, so this trap is
latent in the probe rather than active — but **P8-T05's tray mode would have walked straight
into it**, and from inside the page an ACL refusal is indistinguishable from a webview that
lacks the API. The narrow lesson for P8-T01: write a capability file against the plugins
registered, not against the code the page appears to contain. Recorded in `docs/SURFACE.md`.

### The control, and why it is weaker than the Linux one

The same page in a Chromium on the same Windows box (the in-app preview browser,
Chrome 152.0.7977.76) read WebGPU adapter `nvidia / blackwell` and the identical ANGLE
renderer string — so the shell took nothing away. Its microphone and notification rows are
**not usable as a control**: that browser blocks device capture and notifications at the
harness level, which is a property of the harness, not of Chrome on Windows. The Linux leg's
Chrome control was a real browser and is the stronger of the two.

## The errors, quoted

A failure without its error text is not a finding.

**The microphone, inside the Tauri webview:**

```
getUserMedia rejected — NotAllowedError: The request is not allowed by the user agent or
the platform in the current context, possibly because the user denied permission.
```

No prompt was ever drawn. This is wry's default permission handler refusing rather than a
person refusing, and it would be shell work to fix — which Phase 8 would own if Linux were
shipping on Tauri. It is recorded because it is on the list, not because it blocks
anything now.

**The shell will not start at all on Wayland:**

```
wl_display#1.error(wp_linux_drm_syncobj_surface_v1#57, 2,
                   "Explicit Sync only supported on dmabuf buffers")
Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.
```

The window is genuinely created first — the `WAYLAND_DEBUG=1` trace shows
`xdg_surface.set_window_geometry(45, 45, 1280, 820)` — and then the compositor kills the
client on the first commit. Every measurement in the table above was therefore taken with
`GDK_BACKEND=x11`, under Xwayland, and even there the log carries:

```
Failed to create GBM buffer of size 1280x820: Invalid argument
```

**Two controls, because "it crashed" is worth nothing without them:**

- `gtk3-widget-factory` on the same Wayland session: **runs, silent, no errors.** So GTK3
  itself is not broken on this box.
- WebKitGTK's own `/usr/libexec/webkit2gtk-4.1/MiniBrowser` on the same Wayland session:
  **dies with byte-identical output.** So this is not a Tauri bug and not a wry bug — it
  is WebKitGTK 2.52.5 against Mutter's explicit-sync protocol on the NVIDIA driver.

That distinction matters for what gets reported where, but not for the decision. Even if
the Wayland crash were fixed tomorrow, `navigator.gpu` would still be undefined.

## Is WebGPU merely switched off in WebKitGTK, or absent?

Worth separating, because "off by default" and "not implemented" are different futures for
ADR-07. Evidence from the Fedora build of `libwebkit2gtk-4.1.so.0`:

- The **IPC plumbing is compiled in** — dozens of `WebKit::WebGPU::… convertToBacking(GPU…)`
  symbols, and the preference name `WebGPUEnabled` exists.
- The **JavaScript bindings are not**. `GPUAdapter`, `GPUDevice`, `GPUCanvasContext`,
  `GPUQueue` and `GPUBuffer` appear zero times as interface names, in the library or in
  `WebKitWebProcess`.
- The library ships the literal string **`WebGPU platform is unsupported.`**

Read together: the GTK port carries WebKit's cross-platform WebGPU scaffolding and does not
expose the API. This is consistent with the working group's implementation-status page,
which lists WebKit's WebGPU as enabled only on Apple platforms and does not mention
WebKitGTK or WPE at all — a gap the surface entry was careful to call "not established"
rather than "absent". **It is now established, on this version, by measurement.** This is
`strings` evidence about a build, not a claim about WebKitGTK's roadmap.

## The control found something worse than the thing it was controlling for

Chrome on this box, **as a person would launch it**, has no WebGPU adapter either:

```
| WebGPU (navigator.gpu) | yes | present — which proves nothing on its own; see the adapter row |
| WebGPU adapter | NO | requestAdapter() resolved null — the namespace is there, the device is not |
```

Chrome's own GPU-process sandbox cannot read the Vulkan loader's ICD files:

```
Warning: loader_get_json: Failed to open JSON file nvidia_icd.x86_64.json
Warning: vkCreateInstance: Found no drivers!
Warning: vkCreateInstance failed with VK_ERROR_INCOMPATIBLE_DRIVER
    at CheckVkSuccessImpl (../../third_party/dawn/src/dawn/native/vulkan/VulkanError.cpp:106)
```

Vulkan itself is fine: `vulkaninfo --summary` reports the RTX 5060 Ti as a
`PHYSICAL_DEVICE_TYPE_DISCRETE_GPU`, `DRIVER_ID_NVIDIA_PROPRIETARY`, API 1.4.341,
conformance 1.4.3.3. And with `--disable-gpu-sandbox` Chrome returns a real hardware
adapter, `nvidia / blackwell`. The matrix:

| Chrome flags | Adapter |
|---|---|
| none (Wayland, as launched) | none |
| `--ozone-platform=x11` | none |
| `--ozone-platform=x11 --enable-features=Vulkan` | none |
| `--enable-features=Vulkan --enable-unsafe-webgpu` (Wayland) | **`google / swiftshader` — software** |
| `--disable-gpu-sandbox` (Wayland) | **`nvidia / blackwell`** |
| `--ozone-platform=x11 --enable-features=Vulkan --disable-gpu-sandbox` | **`nvidia / blackwell`** |

So the display server is not the variable; the GPU sandbox is. **Chrome is capable of
hardware WebGPU on this box and does not deliver it by default.** ADR-07's fallback is
still the right call — it is the only path with any hardware WebGPU at all here — but the
fallback is not free on Linux, and shipping it means telling a Linux user something. That
is a Phase 8 problem, recorded now so it is not discovered then.

One caution against over-reading: **this is one box, one distro, one very new driver.** It
is enough to decide Tauri-vs-Chrome, which turns on `navigator.gpu` existing and is not
box-specific. It is not enough to characterise Chrome-on-Linux generally, and the
write-up does not.

### An aside that nearly cost the result

`--enable-features=Vulkan --enable-unsafe-webgpu` produced an adapter that passed every
check the probe made and identified as `google / swiftshader` — the CPU pretending to be a
GPU. The brief warned that a namespace is an advertisement and the adapter is the fact;
this is the next turn of the same screw, and the probe now counts a software rasteriser as
a failure with the word SOFTWARE in the detail. A silent software fallback is worse than a
missing API, because it makes the "yes" that reaches the table.

## Two bugs the measurement found in the measurement

Both are recorded because they are the shape of error that quietly turns a spike's answer
into the wrong one.

**1. The probe in this task's own brief crashes on WebKit.** The brief suggests
`AudioContext.prototype.audioWorklet !== undefined`. WebKit implements `audioWorklet` as a
brand-checked getter, so *reading* it off the prototype throws:

```
TypeError: The BaseAudioContext.audioWorklet getter can only be used on instances of
BaseAudioContext
```

Chrome returns `undefined` and says nothing, so the bug is invisible on the platform the
spike was written on. It took the whole probe down before it reported anything, which
looks exactly like a page that never loaded — a missing result reading as a missing
capability. `'audioWorklet' in AudioContext.prototype` asks the same question without
invoking the getter. `probeCapabilities` now also isolates the synchronous block, so one
throwing getter can never again cost every other row.

**2. `errorText` printed `{}` for a DOMException.** Under jsdom a DOMException is not an
`instanceof Error`, and DOMException is the exact type a webview rejects a permission with
— the one case this spike exists to quote. It is duck-typed on `name`/`message` now. The
`NotAllowedError` quoted above is a result of that fix; before it, that row read `{}`.

A third, smaller one: `Promise.all([capabilities, microphone])` never settled in Chrome,
because an unanswered permission prompt leaves `getUserMedia` pending forever, so the
report never arrived. The microphone probe is raced against a clock now and says
"a permission prompt is most likely open and unanswered" rather than reporting a denial
that never happened.

## The gate question, answered

`pnpm gate` runs cargo against `companion/Cargo.toml` only. A crate under
`apps/desktop/src-tauri` is not in that workspace and would be gated by nothing.

**Decision: it stays out of `pnpm gate`, deliberately, and `pnpm gate:desktop` checks it on
demand.** `apps/desktop/src-tauri/Cargo.toml` declares its own empty `[workspace]` so it is
not silently absorbed into `companion/`, and the reason is written in the manifest next to
the declaration.

Why: gating it means every gate on every machine compiles tauri, wry, tao, muda and the
webkit2gtk bindings — 35 seconds of `cargo check` from warm on this box, considerably worse
cold — and CI's ubuntu runner would need `libwebkit2gtk-4.1-dev` installed before it could
even start. That is a real tax on every commit in Phases 1 through 7 for a crate Phase 8
owns. The thing the brief refuses to allow is an *ungated crate nobody mentions*; this one
has a command, a comment and a paragraph.

**Phase 8 should reverse this**, at the point the desktop app stops being a spike artifact.

## What this spike did not do, and is not pretending to

- ~~**Windows / WebView2 is not measured.**~~ **Done 2026-09-11** — own section above. It was
  a run rather than a build, as predicted.
- ~~**Tray and notifications** are half-answered.~~ **The tray is built and measured on
  Windows** (2026-09-11). The reasoning for skipping it on Linux was sound and is kept here
  because it is worth reading — "building them to test a shell that Linux will not ship
  would have been work in the direction the answer already ruled out" — but it inverts on
  Windows: WebView2 is the container ADR-07 ships *first*, and ADR-14's schedules and
  P8-T05's tray mode are the two features that depend on these rows. The shell grew a tray
  and the notification plugin for that sitting only; the probe page was left alone, so the
  webview readings above are uncontaminated by it. The native notification row is the last
  one outstanding and needs one tray click.
- **The tray was never measured on Linux**, and now never will be by this spike. That is the
  right outcome rather than a gap: Linux does not ship a Tauri app, so a Linux tray icon is
  not a thing the product has.
- **`/spike/voice`, `/spike/avatar` and `/spike/turn` were never run inside the shell.**
  The brief asks for their timings, and with no `navigator.gpu` there are no timings to
  take — Spike A and Spike D cannot start, and Spike B would be measuring an unknown
  software path. Running them to produce numbers nobody would use was not worth Rick's
  machine time. **This is a deliberate gap, not an oversight.**

## What was built

| Piece | What it does |
|---|---|
| `apps/desktop/src-tauri/` | The Tauri 2 shell. Opens a window on the `apps/web` dev server and does nothing else on purpose |
| `apps/desktop/src-tauri/src/lib.rs` | One command, `record`, so a result can leave the container. A Tauri window has no address bar and GNOME refuses screenshots to other processes |
| `apps/desktop/src-tauri/src/lib.rs` (Windows sitting) | A tray with three items, and the OS notification path from Rust — the two rows the Linux leg left unmeasured. Additions to the shell, not to the page, so the capability readings stay clean |
| `apps/desktop/src-tauri/capabilities/default.json` | `notification:default` alongside `core:default`. Not optional once the notification plugin is registered: it polyfills `window.Notification`, so the page crosses the ACL without containing any Tauri code |
| `apps/web/src/spikes/capabilities.ts` | The probe, with tests for each failure shape a webview actually produces |
| `apps/web/src/spikes/ShellProbe.tsx` | `/spike/shell` — the page, printing a copyable markdown table |
| `apps/web/src/App.tsx` | A dev-only route index on the boot screen. Without it a Tauri window opens on `/` and no spike route is reachable from inside it at all |
| `package.json` | `gate:desktop` |
| `.gitattributes` | The icons are excluded from LFS and from eol conversion, deliberately — see below |

**The icons in `apps/desktop/src-tauri/icons/` are Tauri's scaffold logo, not ours.** They
are committed because the shell has to build on the Windows box next and an empty icon set
is a trap, not because they are a design decision. P7/P8 replaces them with Alice's, and
`NOTICE` gets a line if any of them survive to a release. They are also pinned out of Git
LFS in `.gitattributes`: `*.png` is an LFS filter in this repo, and PROJECT.md records that
a plain `git pull && pnpm install` is enough to work here — twelve 32 KB PNGs are not worth
making that false.

## Reproducing this

```bash
pnpm dev                                  # the dev server the shell points at
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
GDK_BACKEND=x11 ./apps/desktop/src-tauri/target/debug/latentpresence-desktop
```

`GDK_BACKEND=x11` is required on GNOME Wayland with the NVIDIA driver or the window dies on
first commit. Then pick "Spike E — webview capabilities" from the boot screen; the table
prints to the terminal that launched it.

On Windows the same three lines, without the backend variable:

```bash
pnpm dev
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml
./apps/desktop/src-tauri/target/debug/latentpresence-desktop.exe
```

Neither `pnpm install` nor the Tauri CLI is needed to reproduce either column — the binary
is run directly and `apps/web`'s dependencies have not changed since. The tray items are the
only part that is not automatic: the capability table, the microphone included, runs and
reports itself the moment the page loads.
