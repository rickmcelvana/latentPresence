import { describe, expect, it } from 'vitest';
import {
  browserGpu,
  describeAdapter,
  isSoftwareRenderer,
  kokoroSupport,
  type AdapterLike,
  type GpuLike,
} from './webgpu';

/** A `navigator.gpu` that answers with whatever the test wants. */
function gpuReturning(adapter: AdapterLike | null): GpuLike {
  return { requestAdapter: () => Promise.resolve(adapter) };
}

describe('kokoroSupport', () => {
  it('reports no-webgpu-api when there is no navigator.gpu — WebKitGTK', async () => {
    const support = await kokoroSupport(null);
    expect(support.supported).toBe(false);
    expect(support.blocker).toBe('no-webgpu-api');
    expect(support.detail).toContain('navigator.gpu');
  });

  it('treats undefined the same as null', async () => {
    expect((await kokoroSupport(undefined)).blocker).toBe('no-webgpu-api');
  });

  it('reports no-webgpu-adapter when requestAdapter resolves null', async () => {
    const support = await kokoroSupport(gpuReturning(null));
    expect(support.blocker).toBe('no-webgpu-adapter');
    expect(support.detail).toContain('resolved null');
  });

  it('quotes what requestAdapter threw, including a non-Error', async () => {
    const support = await kokoroSupport({
      requestAdapter: () => Promise.reject(new Error('no vulkan icd')),
    });
    expect(support.blocker).toBe('no-webgpu-adapter');
    expect(support.detail).toContain('no vulkan icd');
  });

  it('quotes a DOMException-shaped rejection by name and message', async () => {
    const support = await kokoroSupport({
      requestAdapter: () => Promise.reject({ name: 'NotSupportedError', message: 'blocked' }),
    });
    expect(support.detail).toContain('NotSupportedError: blocked');
  });

  it('counts a swiftshader adapter as a failure — Chrome on Linux, Spike E', async () => {
    const support = await kokoroSupport(
      gpuReturning({ info: { vendor: 'google', architecture: 'swiftshader' } }),
    );
    expect(support.supported).toBe(false);
    expect(support.blocker).toBe('software-adapter');
    expect(support.detail).toContain('software rasteriser');
  });

  it('accepts a real adapter and reports what it is — the Windows WebView2 result', async () => {
    const support = await kokoroSupport(
      gpuReturning({ info: { vendor: 'nvidia', architecture: 'blackwell' } }),
    );
    expect(support.supported).toBe(true);
    expect(support.blocker).toBeNull();
    expect(support.detail).toBe('nvidia / blackwell');
  });

  it('accepts an adapter that identifies itself as nothing', async () => {
    const support = await kokoroSupport(gpuReturning({}));
    expect(support.supported).toBe(true);
    expect(support.detail).toContain('no identifying info');
  });
});

describe('isSoftwareRenderer', () => {
  it('names the rasterisers that would silently miss the budget', () => {
    for (const name of ['SwiftShader', 'llvmpipe', 'softpipe', 'lavapipe', 'Microsoft Basic']) {
      expect(isSoftwareRenderer(name)).toBe(true);
    }
  });

  it('does not flag real hardware', () => {
    expect(isSoftwareRenderer('nvidia / blackwell')).toBe(false);
    expect(isSoftwareRenderer('apple / m3')).toBe(false);
  });
});

describe('describeAdapter', () => {
  it('joins what the adapter reports and skips what it does not', () => {
    expect(describeAdapter({ vendor: 'nvidia', architecture: '', device: 'rtx' })).toBe(
      'nvidia / rtx',
    );
  });

  it('is empty for an adapter with no info at all', () => {
    expect(describeAdapter(undefined)).toBe('');
  });
});

describe('browserGpu', () => {
  it('returns null when there is no navigator', () => {
    expect(browserGpu(null)).toBeNull();
  });

  it('returns null when navigator.gpu is missing — the WebKitGTK case', () => {
    expect(browserGpu({ userAgent: 'x' })).toBeNull();
  });

  it('returns null when gpu is present but cannot be asked', () => {
    expect(browserGpu({ gpu: {} })).toBeNull();
  });

  it('returns the gpu when it can actually be asked for an adapter', () => {
    const gpu = { requestAdapter: () => Promise.resolve(null) };
    expect(browserGpu({ gpu })).toBe(gpu);
  });
});
