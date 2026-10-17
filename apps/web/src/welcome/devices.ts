import type { ConnectionResult } from '../settings/connection';

/**
 * The wizard's microphone and camera checks (P8-T02). Everything that touches a device is in
 * `WizardDevices`, so a test hands in a fake and no test opens a real microphone or camera.
 *
 * **Nothing here starts a device on its own.** `getUserMedia` runs only from a click, and every
 * track is stopped when the check ends, whether it worked, failed or the person left the step.
 */
export interface WizardDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Calls `onLevel` (0 to 1) as the stream gets louder; the returned function stops it. */
  startLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void;
  /** How long a check stays on before it stops itself. */
  readonly durationMs: number;
}

export const DEVICE_CHECK_MS = 3000;

export function defaultDevices(): WizardDevices {
  return {
    getUserMedia: async (constraints) => {
      const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
      if (media === undefined) throw new DOMException('No media devices here', 'NotSupportedError');
      return media.getUserMedia(constraints);
    },
    startLevelMeter,
    durationMs: DEVICE_CHECK_MS,
  };
}

function startLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  // Never connected to the speakers: the person would hear themselves.
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centred = (sample - 128) / 128;
      sum += centred * centred;
    }
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
  }, 80);
  return () => {
    window.clearInterval(timer);
    source.disconnect();
    void context.close();
  };
}

/** Stops every track, which is what turns the device (and its light) off. */
export function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export type DeviceKind = 'microphone' | 'camera';

/** What a failed `getUserMedia` means for this person and what to do next, for where they are. */
export function describeMediaError(kind: DeviceKind, error: unknown, inApp: boolean): ConnectionResult {
  const name = error instanceof Error ? error.name : '';
  const cap = kind === 'microphone' ? 'Microphone' : 'Camera';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return inApp
        ? {
            tone: 'danger',
            text: `Windows is not letting this app use the ${kind}.`,
            help: {
              summary: 'Windows said no.',
              steps: [
                `Open Windows Settings, then Privacy & security, then ${cap}.`,
                `Turn on ${cap} access, and turn on "Let desktop apps access your ${kind}".`,
                `Come back here and press Test ${kind} again.`,
              ],
            },
          }
        : {
            tone: 'danger',
            text: `The browser is not letting this page use the ${kind}.`,
            help: {
              summary: 'The browser said no.',
              steps: [
                'Click the site icon to the left of the address bar.',
                `Find ${cap} and set it to Allow.`,
                `Press Test ${kind} again. If the browser asks you to reload the page first, do that.`,
              ],
            },
          };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return {
        tone: 'danger',
        text: `No ${kind} was found.`,
        help: { summary: `No ${kind}.`, steps: [`Plug one in, or turn it on, then press Test ${kind} again.`] },
      };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        tone: 'danger',
        text: `The ${kind} could not be started. Another app may be using it.`,
        help: { summary: `${cap} busy.`, steps: [`Close anything else that uses the ${kind}, then press Test ${kind} again.`] },
      };
    case 'NotSupportedError':
      return {
        tone: 'danger',
        text: `This page cannot reach the ${kind}. A browser only allows that on a secure (https) address or on localhost.`,
      };
    default:
      return {
        tone: 'danger',
        text: `The ${kind} did not start${error instanceof Error && error.message !== '' ? `: ${error.message}` : ''}.`,
        help: { summary: `${cap} failed.`, steps: [`Press Test ${kind} to try again. You can also skip this and set it up later.`] },
      };
  }
}
