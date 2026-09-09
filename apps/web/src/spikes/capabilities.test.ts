import { describe, expect, it } from 'vitest';
import {
  asMarkdownTable,
  detectTauri,
  isSoftwareRenderer,
  probeCapabilities,
  errorText,
  probeMicrophone,
  probeSynchronous,
  probeWebGpu,
  type CapabilityReport,
} from './capabilities';

/**
 * These tests exist because the probe is the instrument, and an instrument that reports
 * "present" for a thing that does not work would have sent the whole spike the wrong way.
 * The cases below are all shapes a webview can actually produce.
 */

/** The smallest object that satisfies the parts of Navigator the probe touches. */
function navigatorWith(gpu: unknown): Navigator {
  return { gpu } as unknown as Navigator;
}

describe('probeWebGpu', () => {
  it('reports the namespace and the adapter as separate facts', async () => {
    const capabilities = await probeWebGpu(
      navigatorWith({
        requestAdapter: async () => ({ info: { vendor: 'nvidia', device: 'RTX 5060 Ti' } }),
      }),
    );

    expect(capabilities.map((capability) => capability.id)).toEqual([
      'webgpu-namespace',
      'webgpu-adapter',
    ]);
    expect(capabilities.every((capability) => capability.present)).toBe(true);
    expect(capabilities[1]?.detail).toContain('RTX 5060 Ti');
  });

  it('calls a namespace with no adapter behind it a failure, not a pass', async () => {
    // The exact shape the brief warns about: the port advertises WebGPU and then cannot
    // produce a device. Counting this as present is the mistake that would have had the
    // write-up say Linux ships on Tauri when the voice pipeline cannot run there.
    const capabilities = await probeWebGpu(navigatorWith({ requestAdapter: async () => null }));

    expect(capabilities[0]?.present).toBe(true);
    expect(capabilities[1]?.present).toBe(false);
    expect(capabilities[1]?.detail).toContain('resolved null');
  });

  it('quotes the error when requestAdapter throws', async () => {
    const capabilities = await probeWebGpu(
      navigatorWith({
        requestAdapter: async () => {
          throw new DOMException('WebGPU is not enabled', 'NotSupportedError');
        },
      }),
    );

    expect(capabilities[1]?.present).toBe(false);
    expect(capabilities[1]?.detail).toContain('NotSupportedError');
    expect(capabilities[1]?.detail).toContain('WebGPU is not enabled');
  });

  it('says navigator.gpu is missing rather than throwing on it', async () => {
    const capabilities = await probeWebGpu(navigatorWith(undefined));

    expect(capabilities.every((capability) => !capability.present)).toBe(true);
    expect(capabilities[0]?.detail).toContain('undefined');
  });
});

describe('errorText', () => {
  it('keeps the name of a DOMException, which is the half that identifies it', () => {
    expect(errorText(new DOMException('Permission denied', 'NotAllowedError'))).toBe(
      'NotAllowedError: Permission denied',
    );
  });

  it('does not print [object Object] for a throw that is not an Error', () => {
    // WebKitGTK rejects with plain objects in places. This line is the difference between
    // a finding and a shrug.
    expect(errorText({ code: 9, reason: 'no portal' })).toContain('no portal');
    expect(errorText('sandbox refused')).toBe('sandbox refused');
  });
});

describe('probeSynchronous', () => {
  it('separates an AudioContext that exists from one that has audioWorklet', () => {
    const withoutWorklet = { prototype: {} } as unknown as typeof AudioContext;
    const [worklet] = probeSynchronous({
      navigator: {},
      AudioContext: withoutWorklet,
    } as unknown as Window);

    expect(worklet?.present).toBe(false);
    expect(worklet?.detail).toContain('exposes no audioWorklet');
  });

  it('survives a brand-checked getter, which is how WebKit implements audioWorklet', () => {
    // The exact shape that took the real probe down on WebKitGTK 2.52.5: reading
    // `audioWorklet` off the prototype throws rather than returning undefined. `in` is
    // the test that answers the question without invoking the getter.
    const prototype = {};
    Object.defineProperty(prototype, 'audioWorklet', {
      get() {
        throw new TypeError(
          'The BaseAudioContext.audioWorklet getter can only be used on instances of BaseAudioContext',
        );
      },
      configurable: true,
    });
    const brandChecked = { prototype } as unknown as typeof AudioContext;

    const [worklet] = probeSynchronous({
      navigator: {},
      AudioContext: brandChecked,
    } as unknown as Window);

    expect(worklet?.present).toBe(true);
  });

  it('treats getUserMedia being a function as presence, and says so in the detail', () => {
    const capabilities = probeSynchronous({
      navigator: { mediaDevices: { getUserMedia: () => {} } },
    } as unknown as Window);
    const media = capabilities.find((capability) => capability.id === 'getusermedia');

    expect(media?.present).toBe(true);
    expect(media?.detail).toContain('presence is not permission');
  });
});

describe('probeMicrophone', () => {
  it('stops every track it opened, so the probe leaves no recording light on', async () => {
    const stopped: string[] = [];
    const track = {
      label: 'Yeti Nano Analogue Stereo',
      stop: () => stopped.push('audio'),
    };
    const capability = await probeMicrophone({
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
      },
    } as unknown as Navigator);

    expect(capability.present).toBe(true);
    expect(capability.detail).toContain('Yeti Nano');
    expect(stopped).toEqual(['audio']);
  });

  it('carries the rejection text, which is the whole result on a denied prompt', async () => {
    const capability = await probeMicrophone({
      mediaDevices: {
        getUserMedia: async () => {
          throw new DOMException('The request is not allowed', 'NotAllowedError');
        },
      },
    } as unknown as Navigator);

    expect(capability.present).toBe(false);
    expect(capability.detail).toContain('NotAllowedError');
  });
});

describe('detectTauri', () => {
  it('knows a Tauri webview from a browser, which is what makes the control a control', () => {
    expect(detectTauri({ __TAURI_INTERNALS__: {} } as unknown as Window)).toBe(true);
    expect(detectTauri({} as unknown as Window)).toBe(false);
  });
});

describe('asMarkdownTable', () => {
  it('writes NO in capitals so a failed row cannot be skimmed past', () => {
    const report: CapabilityReport = {
      capabilities: [
        { id: 'webgpu-adapter', label: 'WebGPU adapter', present: false, detail: 'resolved null' },
      ],
      userAgent: 'irrelevant',
      inTauri: true,
    };

    expect(asMarkdownTable(report)).toContain('| WebGPU adapter | NO | resolved null |');
  });
});

describe('probeCapabilities', () => {
  it('still reports the WebGPU rows when a later check throws', async () => {
    // A probe that reports nothing reads as "the page never loaded", which is the one
    // wrong conclusion this spike must not reach.
    const report = await probeCapabilities({
      navigator: { gpu: undefined },
      document: {
        createElement: () => ({ getContext: () => null }),
      },
      get AudioContext(): never {
        throw new TypeError('nope');
      },
    } as unknown as Window);

    expect(report.capabilities.map((capability) => capability.id)).toContain('webgpu-adapter');
    const fallback = report.capabilities.find(
      (capability) => capability.id === 'synchronous-probe',
    );
    expect(fallback?.detail).toContain('nope');
  });
});

describe('isSoftwareRenderer', () => {
  it('catches the names a CPU rasteriser actually reports', () => {
    // `google / swiftshader` is not hypothetical: it is what Chrome returned on the
    // Fedora box once Vulkan was forced on, and it passed every other check.
    expect(isSoftwareRenderer('google / swiftshader')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 22.1.8, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('nvidia / blackwell')).toBe(false);
  });
});

describe('probeWebGpu, on a software adapter', () => {
  it('counts it as a failure rather than a pass', async () => {
    const capabilities = await probeWebGpu({
      gpu: { requestAdapter: async () => ({ info: { vendor: 'google', architecture: 'swiftshader' } }) },
    } as unknown as Navigator);

    expect(capabilities[1]?.present).toBe(false);
    expect(capabilities[1]?.detail).toContain('SOFTWARE');
  });
});

describe('probeMicrophone, when nobody answers the prompt', () => {
  it('gives up rather than holding the whole report hostage', async () => {
    const capability = await probeMicrophone(
      { mediaDevices: { getUserMedia: () => new Promise(() => {}) } } as unknown as Navigator,
      10,
    );

    expect(capability.present).toBe(false);
    expect(capability.detail).toContain('permission prompt');
  });
});
