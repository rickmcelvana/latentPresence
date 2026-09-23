import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The user's camera PiP (P2-T06, decision 8): `getUserMedia({ video: true, audio: false })`
 * on demand, stopped fully on `stop()` or unmount.
 *
 * **Nothing here reads a pixel.** The stream is handed straight to a `<video>` element by
 * whoever calls this hook; there is no canvas, no `MediaRecorder`, no frame callback and
 * nothing that could carry a pixel anywhere else in this module. That is the whole point
 * of "no processing yet" — the camera is on, and only on, to be looked at.
 *
 * `getUserMedia` is injectable so a jsdom test can exercise start, stop and a refusal
 * without a real camera; production leaves it at the default, `navigator.mediaDevices`.
 */

export interface UseUserCameraDeps {
  readonly getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

export interface UseUserCameraResult {
  readonly stream: MediaStream | null;
  /** Set on a refusal (denied permission, no camera, …); cleared on the next `start()`. */
  readonly error: string | null;
  readonly active: boolean;
  start(): Promise<void>;
  stop(): void;
}

function defaultGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function useUserCamera(deps: UseUserCameraDeps = {}): UseUserCameraResult {
  const getUserMedia = deps.getUserMedia ?? defaultGetUserMedia;
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read by `stop` and by the unmount effect, which must not depend on `stream` itself —
  // that would tear the camera down and rebuild the effect on every frame the stream's
  // own identity happened to change, which `getUserMedia` never does mid-stream, but
  // nothing here should rely on that staying true.
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback((): void => {
    const current = streamRef.current;
    if (current !== null) for (const track of current.getTracks()) track.stop();
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(async (): Promise<void> => {
    try {
      const media = await getUserMedia({ video: true, audio: false });
      streamRef.current = media;
      setStream(media);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStream(null);
    }
  }, [getUserMedia]);

  // Stops every track on unmount — a PiP toggled off by leaving the page must not leave
  // the camera's light on.
  useEffect(() => stop, [stop]);

  return { stream, error, active: stream !== null, start, stop };
}
