import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelDescriptor } from '@latentpresence/protocol';
import { ConsentScreen } from './ConsentScreen';

afterEach(cleanup);

const SILERO: ModelDescriptor = {
  id: 'onnx-community/silero-vad@e71cae9:onnx/model.onnx',
  label: 'Silero VAD (voice activity)',
  sizeBytes: 2_243_022,
  licence: 'MIT',
  sourceUrl: 'https://huggingface.co/onnx-community/silero-vad',
};
const KOKORO: ModelDescriptor = {
  id: 'onnx-community/Kokoro-82M-v1.0-ONNX:fp32',
  label: 'Kokoro 82M (text to speech, fp32)',
  sizeBytes: 325_532_232,
  licence: 'Apache-2.0',
  sourceUrl: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX',
};

describe('ConsentScreen', () => {
  it('renders every field of every descriptor', () => {
    render(<ConsentScreen descriptors={[SILERO, KOKORO]} onAgree={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(SILERO.label)).toBeTruthy();
    expect(screen.getByText(/2\.2 MB/)).toBeTruthy();
    expect(screen.getByText(/MIT/)).toBeTruthy();
    expect(screen.getByText(KOKORO.label)).toBeTruthy();
    expect(screen.getByText(/325\.5 MB/)).toBeTruthy();
    expect(screen.getByText(/Apache-2\.0/)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'source' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([SILERO.sourceUrl, KOKORO.sourceUrl]);
    for (const link of links) expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('shows the total of every model listed', () => {
    render(<ConsentScreen descriptors={[SILERO, KOKORO]} onAgree={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('327.8 MB total')).toBeTruthy();
  });

  it('Cancel calls back without granting anything itself', () => {
    const onCancel = vi.fn();
    const onAgree = vi.fn();
    render(<ConsentScreen descriptors={[SILERO]} onAgree={onAgree} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAgree).not.toHaveBeenCalled();
  });

  it('Agree calls back for exactly the ids shown', () => {
    const onAgree = vi.fn();
    render(<ConsentScreen descriptors={[SILERO, KOKORO]} onAgree={onAgree} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agree' }));
    expect(onAgree).toHaveBeenCalledTimes(1);
  });

  it('says the plain thing about where the weights go', () => {
    render(<ConsentScreen descriptors={[SILERO]} onAgree={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/stay in this browser/)).toBeTruthy();
  });
});
