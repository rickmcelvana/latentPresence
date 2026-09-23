import { describe, expect, it } from 'vitest';
import { GazeTargetSchema } from '@latentpresence/protocol';
import { type Vec3, gazePoint } from './gaze';

const HEAD: Vec3 = [0, 1.4, 0];
/** The default framing: camera in front of the face, VRM 1.0 facing +Z. */
const CAMERA: Vec3 = [0, 1.4, 1.6];

describe('gazePoint', () => {
  it('looks at the camera for the user', () => {
    expect(gazePoint('user', HEAD, CAMERA)).toEqual(CAMERA);
  });

  it('puts every other target in front of the head, not behind it', () => {
    for (const target of GazeTargetSchema.options) {
      const [, , z] = gazePoint(target, HEAD, CAMERA);
      expect(z).toBeGreaterThan(HEAD[2]);
    }
  });

  it('looks down for down and the screen, and to opposite sides for away and screen', () => {
    expect(gazePoint('down', HEAD, CAMERA)[1]).toBeLessThan(HEAD[1]);
    expect(gazePoint('screen', HEAD, CAMERA)[1]).toBeLessThan(HEAD[1]);
    // Facing +Z, the character's left is +X.
    expect(gazePoint('away', HEAD, CAMERA)[0]).toBeGreaterThan(0);
    expect(gazePoint('screen', HEAD, CAMERA)[0]).toBeLessThan(0);
  });

  it('keeps wander close to the user, where the life layer can move it', () => {
    const [x, y] = gazePoint('wander', HEAD, CAMERA);
    expect(Math.abs(x)).toBeLessThan(0.3);
    expect(Math.abs(y - HEAD[1])).toBeLessThan(0.3);
  });

  it('turns with the camera, so "away" stays away from any framing', () => {
    // Camera off to the character's right: forward is now +X-ish, left is -Z-ish.
    const side: Vec3 = [1.6, 1.4, 0];
    const away = gazePoint('away', HEAD, side);
    expect(away[0]).toBeGreaterThan(0);
    expect(away[2]).toBeLessThan(0);
  });

  it('ignores camera height for everything but the user', () => {
    const high: Vec3 = [0, 2.4, 1.6];
    expect(gazePoint('down', HEAD, high)).toEqual(gazePoint('down', HEAD, CAMERA));
  });

  it('assumes VRM forward when the camera is straight above the head', () => {
    const [, , z] = gazePoint('down', HEAD, [0, 3, 0]);
    expect(z).toBeGreaterThan(0);
  });
});
