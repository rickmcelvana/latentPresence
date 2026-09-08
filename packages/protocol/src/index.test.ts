import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, describePackage } from './index';

describe('@latentpresence/protocol', () => {
  it('stamps every package with the version it was compiled against', () => {
    // Guards the one thing the scaffold owns here: a package that reports a version
    // it did not get from this module would mean two copies of the protocol are loaded.
    expect(describePackage('x')).toEqual({ name: 'x', protocolVersion: PROTOCOL_VERSION });
  });
});
