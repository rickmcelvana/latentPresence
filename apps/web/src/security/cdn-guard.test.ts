import { describe, expect, it } from 'vitest';
import { cdnRuntimeProblems } from './cdn-guard';

const DEFAULT = 'x.wasm.wasmPaths=`https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/`';
const OWN = 'lh={mjs:`/assets/ort-wasm-simd-threaded.jsep-B0TxsgQ-.mjs`,wasm:`/assets/x.wasm`}';

describe('cdnRuntimeProblems', () => {
  it('names a worker that keeps the library default, as Smart Turn did', () => {
    expect(cdnRuntimeProblems([{ fileName: 'assets/smart-turn.worker-Bqy6OH39.js', code: DEFAULT }])).toEqual([expect.stringContaining('smart-turn.worker')]);
  });

  it('passes one that sets the build\'s own runtime over it', () => {
    expect(cdnRuntimeProblems([{ fileName: 'assets/kokoro.worker-CPjPscXX.js', code: `${DEFAULT};${OWN}` }])).toEqual([]);
  });

  it('is not fooled by the name ONNX Runtime gives the file before any path is set', () => {
    expect(cdnRuntimeProblems([{ fileName: 'assets/a.js', code: `${DEFAULT};r=\`ort-wasm-simd-threaded.jsep.mjs\`` }])).toHaveLength(1);
  });

  it('ignores what has no CDN address, and what is not script', () => {
    expect(cdnRuntimeProblems([{ fileName: 'assets/vad.worker-a.js', code: 'ort' }, { fileName: 'assets/theme.css', code: 'cdn.jsdelivr.net' }])).toEqual([]);
  });
});
