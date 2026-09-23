import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUserCamera } from './useUserCamera';

afterEach(cleanup);

function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream(trackCount = 2): { stream: MediaStream; tracks: MediaStreamTrack[] } {
  const tracks = Array.from({ length: trackCount }, fakeTrack);
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

describe('useUserCamera', () => {
  it('starts with nothing active and no error', () => {
    const { result } = renderHook(() => useUserCamera({ getUserMedia: vi.fn() }));
    expect(result.current.active).toBe(false);
    expect(result.current.stream).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('start() gives back the stream getUserMedia resolves with', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const { result } = renderHook(() => useUserCamera({ getUserMedia }));

    await act(() => result.current.start());

    expect(result.current.stream).toBe(stream);
    expect(result.current.active).toBe(true);
    // Video only, never audio — this PiP shows the person, it does not add a second mic.
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
  });

  it('stop() stops every track and clears the stream', async () => {
    const { stream, tracks } = fakeStream(3);
    const getUserMedia = vi.fn(async () => stream);
    const { result } = renderHook(() => useUserCamera({ getUserMedia }));

    await act(() => result.current.start());
    act(() => result.current.stop());

    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(result.current.stream).toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('a refusal reports an error and leaves the camera off', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('Permission denied');
    });
    const { result } = renderHook(() => useUserCamera({ getUserMedia }));

    await act(() => result.current.start());

    expect(result.current.error).toBe('Permission denied');
    expect(result.current.active).toBe(false);
    expect(result.current.stream).toBeNull();
  });

  it('stops every track on unmount', async () => {
    const { stream, tracks } = fakeStream(2);
    const getUserMedia = vi.fn(async () => stream);
    const { result, unmount } = renderHook(() => useUserCamera({ getUserMedia }));

    await act(() => result.current.start());
    unmount();

    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
