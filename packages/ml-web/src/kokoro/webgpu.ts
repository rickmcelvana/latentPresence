/**
 * Can Kokoro run in this browser? (P1-T05)
 *
 * The plan's rule is that `kokoro-browser` requires WebGPU and that a user without it is
 * steered to a server endpoint. Steering is the settings UI's job (P1-T10/P1-T13); this
 * module is the fact the UI steers on, and it is deliberately a *reason*, not a boolean,
 * so the screen can say which of the three failures happened instead of "unavailable".
 *
 * Three Phase 0 results decide the shape of this check:
 *
 * - Spike A measured synthesis at **245 ms on WebGPU against 3779 ms on wasm**. wasm is
 *   not a slower path, it is a different product; ADR-20's 500 ms budget is unreachable
 *   on it. The Windows leg later found that figure was single-threaded (no COOP/COEP in
 *   the Vite dev server), so wasm may yet be better than 3779 ms — until someone
 *   measures it with cross-origin isolation on, this refuses wasm.
 * - Spike E found `navigator.gpu` **undefined** in WebKitGTK 2.52.5, which is why the
 *   namespace is asked about separately.
 * - Chrome on Linux with `--enable-unsafe-webgpu` returned a **swiftshader** adapter:
 *   software, which passes a naive check and silently misses every budget. So an adapter
 *   that names a software rasteriser is a failure here, exactly as the Spike E probe
 *   counted it.
 */

/** The part of `GPUAdapterInfo` this module reads. */
export interface AdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

/** The part of `GPUAdapter` this module reads. */
export interface AdapterLike {
  readonly info?: AdapterInfoLike;
}

/**
 * The part of `navigator.gpu` this module calls. Declared structurally so the package
 * needs no `@webgpu/types`: a real `GPU` satisfies it, and a test satisfies it with an
 * object literal.
 */
export interface GpuLike {
  requestAdapter(): Promise<AdapterLike | null>;
}

/** Why Kokoro cannot run here. `null` from `kokoroSupport` means it can. */
export type KokoroBlocker =
  /** No `navigator.gpu` at all — WebKitGTK, or a browser too old. */
  | 'no-webgpu-api'
  /** `requestAdapter()` resolved null or threw: the namespace is there, the device is not. */
  | 'no-webgpu-adapter'
  /** An adapter, but a software rasteriser. Would run, would miss the budget by 10x. */
  | 'software-adapter';

export interface KokoroSupport {
  readonly supported: boolean;
  readonly blocker: KokoroBlocker | null;
  /**
   * What was learned beyond yes/no — the adapter's vendor and architecture, or the text
   * of whatever `requestAdapter()` threw. Spike E's rule: "didn't work" is not a finding.
   */
  readonly detail: string;
}

const SOFTWARE_RENDERERS = ['swiftshader', 'llvmpipe', 'softpipe', 'lavapipe', 'microsoft basic'];

/** True when an adapter description names a software rasteriser. Same list as the Spike E
 * probe, kept in step deliberately: a renderer that is a lie there is a lie here. */
export function isSoftwareRenderer(description: string): boolean {
  const lowered = description.toLowerCase();
  return SOFTWARE_RENDERERS.some((name) => lowered.includes(name));
}

/** The adapter in one line, for the detail field. Empty when it reports nothing, which
 * some ports do and which is not itself a failure. */
export function describeAdapter(info: AdapterInfoLike | undefined): string {
  if (info === undefined) return '';
  const parts = [info.vendor, info.architecture, info.device, info.description];
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' / ');
}

/**
 * The message an unknown throw carries. WebKitGTK rejects with things that are not
 * `Error`, and duck-typing beats `instanceof` because a DOMException from another realm
 * is not an `Error` instance either (the same trap the Spike E probe documents).
 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message === 'string' && message !== '') {
      return typeof name === 'string' && name !== '' && name !== 'Error'
        ? `${name}: ${message}`
        : message;
    }
  }
  return String(error);
}

/**
 * Ask the port what it actually has. `gpu` is passed in rather than read from a global so
 * this is testable in node; `browserGpu()` is what supplies it in a browser.
 */
export async function kokoroSupport(gpu: GpuLike | null | undefined): Promise<KokoroSupport> {
  if (gpu === null || gpu === undefined) {
    return {
      supported: false,
      blocker: 'no-webgpu-api',
      detail: 'navigator.gpu is undefined — this browser exposes no WebGPU at all',
    };
  }

  let adapter: AdapterLike | null;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    return {
      supported: false,
      blocker: 'no-webgpu-adapter',
      detail: `requestAdapter() threw — ${errorText(error)}`,
    };
  }

  if (adapter === null) {
    return {
      supported: false,
      blocker: 'no-webgpu-adapter',
      detail: 'requestAdapter() resolved null — the namespace is there, the device is not',
    };
  }

  const described = describeAdapter(adapter.info);
  if (described !== '' && isSoftwareRenderer(described)) {
    return {
      supported: false,
      blocker: 'software-adapter',
      detail: `${described} — software rasteriser, which cannot hold the 500 ms budget`,
    };
  }

  return {
    supported: true,
    blocker: null,
    detail: described === '' ? 'adapter returned, reporting no identifying info' : described,
  };
}

/** `navigator.gpu`, or null. Read structurally: the DOM lib in this package has no
 * WebGPU types and adding `@webgpu/types` for one property is not worth a dependency. */
export function browserGpu(nav: unknown = globalThis.navigator): GpuLike | null {
  if (typeof nav !== 'object' || nav === null) return null;
  const { gpu } = nav as { gpu?: unknown };
  if (typeof gpu !== 'object' || gpu === null) return null;
  if (typeof (gpu as { requestAdapter?: unknown }).requestAdapter !== 'function') return null;
  return gpu as GpuLike;
}
