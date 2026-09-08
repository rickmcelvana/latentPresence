import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@latentpresence/protocol';
import { packageInfo } from './index';

describe('@latentpresence/providers', () => {
  it('resolves the protocol package through the workspace link', () => {
    // Fails if the workspace dependency, the exports map or the project reference
    // breaks, which is exactly what this package is for until P1 fills it in.
    expect(packageInfo.name).toBe('@latentpresence/providers');
    expect(packageInfo.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
