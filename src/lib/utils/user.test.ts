import { describe, expect, it } from 'vitest';
import { getDisplayName, publicKeyX, samePublicKey } from './user';

const X =
  'a9e4bc3e7bd3d535128bdf1f15e5082d22225bb05009a0dc5cb5f7be87ba0379';
const Y =
  '82b7cf0f99600a001851a5555ff94eec5a39eed9fbf7e18b40d2dd6a6a23e0c4';

describe('publicKeyX', () => {
  it('reads the X coordinate from an uncompressed key', () => {
    expect(publicKeyX(`0x04${X}${Y}`)).toBe(X);
  });

  it('reads the X coordinate from a compressed key', () => {
    expect(publicKeyX(`0x02${X}`)).toBe(X);
    expect(publicKeyX(`0x03${X}`)).toBe(X);
  });

  it('is case-insensitive and tolerates a missing prefix', () => {
    expect(publicKeyX(X.toUpperCase())).toBe(X);
    expect(publicKeyX(`0x02${X.toUpperCase()}`)).toBe(X);
  });

  it('leaves an unknown form as it is', () => {
    expect(publicKeyX('zQ3sh')).toBe('zq3sh');
  });
});

describe('samePublicKey', () => {
  it('matches the same key in compressed and uncompressed form', () => {
    // The login key in settings is uncompressed; a channel message's `from` is
    // compressed. Before this they were compared as strings and never matched.
    expect(samePublicKey(`0x04${X}${Y}`, `0x02${X}`)).toBe(true);
    expect(samePublicKey(`0x02${X}`, `0x04${X}${Y}`)).toBe(true);
  });

  it('rejects different keys', () => {
    const other = `0x02${'b'.repeat(64)}`;
    expect(samePublicKey(`0x02${X}`, other)).toBe(false);
  });

  it('rejects a missing key on either side', () => {
    expect(samePublicKey(undefined, `0x02${X}`)).toBe(false);
    expect(samePublicKey(`0x02${X}`, '')).toBe(false);
  });
});

describe('getDisplayName', () => {
  it('prefers the ENS name over the random alias', () => {
    // status-go generates a three-word alias when a profile has no display name;
    // it says nothing about the person, while the .eth name was chosen.
    expect(
      getDisplayName({
        alias: 'Responsible Weepy Neonbluehermitcrab',
        ensName: 'stauri.stateofus.eth',
      })
    ).toBe('stauri.stateofus.eth');
  });

  it('keeps a display name ahead of the ENS name', () => {
    expect(
      getDisplayName({ displayName: 'Magnus', ensName: 'stauri.stateofus.eth' })
    ).toBe('Magnus');
  });

  it('falls back to the alias when there is no ENS name', () => {
    expect(getDisplayName({ alias: 'Responsible Weepy Neonbluehermitcrab' })).toBe(
      'Responsible Weepy Neonbluehermitcrab'
    );
  });
});
