/**
 * The capability probe for P0-T08 Spike E.
 *
 * ADR-07 ships Windows first on Tauri 2 and names WebKitGTK as the risk. This module is
 * the measurement that settles it: it runs *inside* whatever webview is hosting the page
 * and reports what that webview actually provides, not what it advertises.
 *
 * The distinction is the whole point. `navigator.gpu` existing is an advertisement;
 * `requestAdapter()` returning an adapter is the fact. Spike B already caught Chrome
 * ignoring `powerPreference` on Windows, so a namespace check alone would have been
 * worth nothing here.
 *
 * Three Phase 0 results ride on the WebGPU answer: Spike A measured synthesis at 947 ms
 * on WebGPU against 3779 ms on wasm, Spike D found Smart Turn's int8 build will not load
 * on WebGPU at all, and Spike B's avatar wants a GPU path.
 */

/** One line of the report. */
export interface Capability {
  /** Stable key, used as the row id and in the write-up's table. */
  readonly id: string;
  /** What the write-up calls it. */
  readonly label: string;
  /** Whether the capability is actually usable, as opposed to merely present. */
  readonly present: boolean;
  /**
   * What was learned beyond yes/no — an adapter's vendor, a renderer string, the reason
   * a thing failed. Failures carry their error text: "didn't work" is not a finding.
   */
  readonly detail: string;
}

export interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly userAgent: string;
  /** True when the page is running inside a Tauri webview rather than a browser. */
  readonly inTauri: boolean;
}

/**
 * The message an unknown throw carries.
 *
 * WebKitGTK rejects with things that are not `Error` — a bare string, or a DOMException
 * whose `name` matters more than its `message`. Quoting whatever came back beats
 * `String(error)` printing "[object Object]" into the one line of the spike that is
 * supposed to be the finding.
 */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;

  // Duck-typed rather than `instanceof Error`, and that is not fussiness: under jsdom a
  // DOMException is not an instance of Error, so the `instanceof` version of this
  // function printed a denied microphone as "{}". DOMException is the exact type a
  // webview rejects a permission or an unsupported API with — the one case this whole
  // spike exists to quote — so it must not depend on which realm the object came from.
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string' && message !== '') {
      return typeof name === 'string' && name !== '' && name !== 'Error'
        ? `${name}: ${message}`
        : message;
    }
  }

  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * WebGPU, in two steps, because the namespace and the adapter are different questions.
 *
 * A webview can expose `navigator.gpu` and then fail to find a device — which on Linux is
 * the likely shape of a failure, since the adapter is where the driver, the compositor
 * and the sandbox all have to agree.
 */
export async function probeWebGpu(nav: Navigator = navigator): Promise<Capability[]> {
  const gpu = (nav as Navigator & { gpu?: GPU }).gpu;

  if (!gpu) {
    return [
      {
        id: 'webgpu-namespace',
        label: 'WebGPU (navigator.gpu)',
        present: false,
        detail: 'navigator.gpu is undefined — the port does not expose WebGPU at all',
      },
      {
        id: 'webgpu-adapter',
        label: 'WebGPU adapter',
        present: false,
        detail: 'not reached: there is no navigator.gpu to ask',
      },
    ];
  }

  const namespace: Capability = {
    id: 'webgpu-namespace',
    label: 'WebGPU (navigator.gpu)',
    present: true,
    detail: 'present — which proves nothing on its own; see the adapter row',
  };

  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      return [
        namespace,
        {
          id: 'webgpu-adapter',
          label: 'WebGPU adapter',
          present: false,
          detail: 'requestAdapter() resolved null — the namespace is there, the device is not',
        },
      ];
    }
    const info = adapter.info as GPUAdapterInfo | undefined;
    const described = info
      ? [info.vendor, info.architecture, info.device, info.description]
          .filter((part) => part !== undefined && part !== '')
          .join(' / ')
      : '';
    const software = isSoftwareRenderer(described);
    return [
      namespace,
      {
        id: 'webgpu-adapter',
        label: 'WebGPU adapter',
        // A software adapter is reported as a failure on purpose. It is not what any
        // Phase 0 measurement was taken against, and calling it present would put a
        // "yes" in the write-up's table for a configuration that cannot hold the budget.
        present: !software,
        detail:
          described === ''
            ? 'adapter returned, reporting no identifying info'
            : software
              ? `${described} — SOFTWARE rasteriser, counted as a failure`
              : described,
      },
    ];
  } catch (error) {
    return [
      namespace,
      {
        id: 'webgpu-adapter',
        label: 'WebGPU adapter',
        present: false,
        detail: `requestAdapter() threw — ${errorText(error)}`,
      },
    ];
  }
}

/**
 * WebGL 2, which is the floor rather than the target. The avatar can run on it; the
 * voice pipeline cannot use it at all, so a box with WebGL and no WebGPU is still a
 * no-go for the pipeline ADR-20 budgets.
 */
export function probeWebGl(doc: Document = document): Capability {
  let context: WebGL2RenderingContext | null = null;
  try {
    context = doc.createElement('canvas').getContext('webgl2');
  } catch (error) {
    return {
      id: 'webgl2',
      label: 'WebGL 2',
      present: false,
      detail: `getContext('webgl2') threw — ${errorText(error)}`,
    };
  }

  if (!context) {
    return {
      id: 'webgl2',
      label: 'WebGL 2',
      present: false,
      detail: "getContext('webgl2') returned null",
    };
  }

  // UNMASKED_RENDERER_WEBGL names the actual GPU rather than the port's generic string,
  // which is how a software fallback gets caught pretending to be hardware.
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
  const renderer = debugInfo
    ? String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : String(context.getParameter(context.RENDERER));
  return { id: 'webgl2', label: 'WebGL 2', present: true, detail: renderer };
}

/**
 * The rest of the pipeline's requirements, all synchronous presence checks.
 *
 * The microphone is deliberately *not* requested here. Asking for it pops a permission
 * prompt, and on Linux that prompt is the webview's to draw — a thing worth measuring on
 * its own, with a button, rather than as a side effect of loading the page.
 */
export function probeSynchronous(win: Window = window): Capability[] {
  const nav = win.navigator;
  const audioContext = (win as Window & { AudioContext?: typeof AudioContext }).AudioContext;

  return [
    {
      id: 'audioworklet',
      // `in`, not `.audioWorklet !== undefined`, and this is a finding rather than a
      // style choice. WebKit implements `audioWorklet` as a brand-checked getter, so
      // *reading* it off the prototype throws "The BaseAudioContext.audioWorklet getter
      // can only be used on instances of BaseAudioContext". Chrome returns undefined and
      // says nothing. The probe in this task's own brief uses the reading form, so on
      // WebKitGTK it took the whole probe down before it reported anything — the failure
      // mode where a missing result looks like a missing capability.
      label: 'AudioWorklet',
      present: Boolean(audioContext && 'audioWorklet' in audioContext.prototype),
      detail: audioContext
        ? 'audioWorklet' in audioContext.prototype
          ? 'AudioContext.prototype has audioWorklet'
          : 'AudioContext exists but exposes no audioWorklet'
        : 'no AudioContext constructor',
    },
    {
      id: 'getusermedia',
      label: 'getUserMedia (API present)',
      present: typeof nav.mediaDevices?.getUserMedia === 'function',
      detail:
        typeof nav.mediaDevices?.getUserMedia === 'function'
          ? 'present — presence is not permission; use the button to actually open a mic'
          : 'navigator.mediaDevices.getUserMedia is not a function',
    },
    {
      id: 'sharedarraybuffer',
      label: 'SharedArrayBuffer',
      present: typeof (win as Window & { SharedArrayBuffer?: unknown }).SharedArrayBuffer !==
        'undefined',
      detail: `crossOriginIsolated = ${String(
        (win as Window & { crossOriginIsolated?: boolean }).crossOriginIsolated,
      )}`,
    },
    {
      id: 'notifications',
      label: 'Notification API',
      present: 'Notification' in win,
      detail:
        'Notification' in win
          ? `permission = ${(win as Window & { Notification: { permission: string } }).Notification.permission}`
          : 'no window.Notification — a tray/notification path would have to be the Rust side',
    },
  ];
}

/**
 * Renderers that are the CPU wearing a GPU's name.
 *
 * This list is here because the measurement produced one: Chrome on this box, given
 * `--enable-features=Vulkan --enable-unsafe-webgpu`, returned an adapter identifying as
 * `google / swiftshader`. That is a pass by every check above and a catastrophe by every
 * check that matters — Spike A's 947 ms budget assumes a GPU, and software WebGPU would
 * miss it the way wasm synthesis missed it, by a factor. An adapter is the fact, and
 * *which* adapter is the fact behind that.
 */
const SOFTWARE_RENDERERS = ['swiftshader', 'llvmpipe', 'softpipe', 'lavapipe', 'microsoft basic'];

/** True when a renderer or adapter string names a software rasteriser. */
export function isSoftwareRenderer(description: string): boolean {
  const lowered = description.toLowerCase();
  return SOFTWARE_RENDERERS.some((name) => lowered.includes(name));
}

/** True when the page is inside a Tauri webview rather than a browser on the same box. */
export function detectTauri(win: Window = window): boolean {
  return '__TAURI_INTERNALS__' in win || '__TAURI__' in win;
}

/** The whole probe. */
export async function probeCapabilities(win: Window = window): Promise<CapabilityReport> {
  const [gpu, gl] = [await probeWebGpu(win.navigator), probeWebGl(win.document)];

  // Guarded, because the first version of this function was not and one throwing getter
  // cost the whole report. A probe that reports nothing is worse than one that reports a
  // failed row: the first looks like the page never ran.
  let synchronous: Capability[];
  try {
    synchronous = probeSynchronous(win);
  } catch (error) {
    synchronous = [
      {
        id: 'synchronous-probe',
        label: 'Remaining capability checks',
        present: false,
        detail: `the probe itself threw — ${errorText(error)}`,
      },
    ];
  }

  return {
    capabilities: [...gpu, gl, ...synchronous],
    userAgent: win.navigator.userAgent,
    inTauri: detectTauri(win),
  };
}

/**
 * Actually open a microphone, on a click.
 *
 * Separate from the probe because it is a different claim: the API being present says the
 * port compiled the binding in, and a stream arriving says the webview, the portal and
 * PipeWire all agreed. Spike A needs the second one.
 */
export async function probeMicrophone(
  nav: Navigator = navigator,
  timeoutMs = 8000,
): Promise<Capability> {
  if (typeof nav.mediaDevices?.getUserMedia !== 'function') {
    return {
      id: 'microphone',
      label: 'Microphone (live)',
      present: false,
      detail: 'not attempted: getUserMedia is not a function',
    };
  }
  // Raced against a clock, because a browser that shows a permission prompt leaves this
  // promise pending until somebody answers it — and the first version of this made the
  // whole report wait on that, so a prompt nobody saw looked like a page that never ran.
  const timeout = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const stream = await Promise.race([nav.mediaDevices.getUserMedia({ audio: true }), timeout]);
    if (stream === 'timeout') {
      return {
        id: 'microphone',
        label: 'Microphone (live)',
        present: false,
        detail: `no answer in ${timeoutMs} ms — a permission prompt is most likely open and unanswered`,
      };
    }
    const label = stream.getAudioTracks()[0]?.label ?? '(track with no label)';
    // Release it immediately — the spike wants the answer, not the recording light.
    for (const track of stream.getTracks()) track.stop();
    return {
      id: 'microphone',
      label: 'Microphone (live)',
      present: true,
      detail: `stream opened: ${label}`,
    };
  } catch (error) {
    return {
      id: 'microphone',
      label: 'Microphone (live)',
      present: false,
      detail: `getUserMedia rejected — ${errorText(error)}`,
    };
  }
}

/**
 * The report as the write-up's markdown table, so the numbers reach `docs/spikes/` by
 * copy rather than by retyping. A transcription error in a spike result is indefensible
 * and this is two lines of code.
 */
export function asMarkdownTable(report: CapabilityReport): string {
  const rows = report.capabilities.map(
    (capability) =>
      `| ${capability.label} | ${capability.present ? 'yes' : 'NO'} | ${capability.detail} |`,
  );
  return ['| Capability | Present | Detail |', '|---|---|---|', ...rows].join('\n');
}

/**
 * Hand the report to the Rust side, which prints it to the terminal that launched the
 * shell.
 *
 * `withGlobalTauri` puts `invoke` on the window, so this needs no `@tauri-apps/api`
 * dependency in a web app that is not a desktop app. In a browser the global is absent
 * and this is a no-op, which is exactly right: the control run has a devtools console.
 */
export async function reportToHost(report: string, win: Window = window): Promise<boolean> {
  // Indexed rather than dotted: oxlint's `no-underscore-dangle` rejects `win.__TAURI__`,
  // and the key is Tauri's to name, not ours.
  const globals = win as unknown as Record<string, { core?: { invoke?: unknown } } | undefined>;
  // Always log it too. WebKitGTK's MiniBrowser prints page console messages to the
  // terminal, which makes it a readable control for the same webview without Tauri —
  // and it is the only readout at all when the Tauri global is missing.
  console.info(report);

  const invoke = globals['__TAURI__']?.core?.invoke;
  if (typeof invoke !== 'function') return false;
  try {
    await (invoke as (command: string, args: unknown) => Promise<unknown>)('record', { report });
    return true;
  } catch {
    // Never let the reporting path fail the measurement it is reporting.
    return false;
  }
}
