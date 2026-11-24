import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENS_DOMAIN,
  ENS_DOMAINS,
  ensState,
  fullEnsName,
  resetEnsForm,
  setEnsDomain,
} from './ensStore.svelte';

describe('ENS form', () => {
  beforeEach(() => {
    resetEnsForm();
  });

  it('offers both domains and defaults to the Status registrar', () => {
    expect(ENS_DOMAINS).toEqual(['stateofus.eth', 'eth']);
    expect(ensState.domain).toBe(ENS_DOMAIN);
  });

  it('builds the full name from the label and the chosen domain', () => {
    expect(fullEnsName('stauri', 'eth')).toBe('stauri.eth');
    expect(fullEnsName('  Stauri  ', 'stateofus.eth')).toBe('stauri.stateofus.eth');
    // The current domain is used when none is given.
    expect(fullEnsName('stauri')).toBe(`stauri.${ensState.domain}`);
    expect(fullEnsName('', 'eth')).toBe('');
  });

  it('drops the previous answer when the domain changes', () => {
    ensState.username = 'stauri';
    ensState.price = 42n;
    ensState.fee = 1n;
    ensState.taken = true;
    ensState.owner = '0x0000000000000000000000000000000000000001';
    ensState.checkError = 'boom';

    setEnsDomain('eth');

    expect(ensState.domain).toBe('eth');
    // "stauri" may be free under one domain and taken under the other: the old
    // answer must not survive the switch.
    expect(ensState.taken).toBe(false);
    expect(ensState.owner).toBe('');
    expect(ensState.price).toBeNull();
    expect(ensState.fee).toBeNull();
    expect(ensState.checkError).toBe('');
  });

  it('resets the form without touching the names the profile knows', () => {
    ensState.username = 'stauri';
    ensState.step = 'done';
    ensState.fullName = 'stauri.stateofus.eth';
    ensState.txHash = '0xabc';
    ensState.profileNames = ['stauri.stateofus.eth'];

    resetEnsForm();

    expect(ensState.step).toBe('form');
    expect(ensState.username).toBe('');
    expect(ensState.fullName).toBe('');
    expect(ensState.txHash).toBe('');
    expect(ensState.domain).toBe(ENS_DOMAIN);
    expect(ensState.profileNames).toEqual(['stauri.stateofus.eth']);
  });
});
