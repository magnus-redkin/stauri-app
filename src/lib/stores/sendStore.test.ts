import { describe, it, expect } from 'vitest';
import { classifySendError } from './sendStore.svelte';

/**
 * Classification of send failures.
 *
 * The error texts are taken from real status-go responses. Each case must yield
 * its own code, because the code selects the hint the user sees: "enter the
 * password again" or "check the connection".
 */
describe('classifySendError', () => {
  it('узнаёт неверный пароль', () => {
    expect(classifySendError('[keystore] incorrect password provided')).toBe('send-wrong-password');
    expect(classifySendError('could not decrypt key with given password')).toBe('send-wrong-password');
  });

  it('узнаёт нехватку средств', () => {
    expect(classifySendError('insufficient funds for gas * price + value')).toBe('send-insufficient-funds');
    expect(classifySendError('transaction value exceeds balance')).toBe('send-insufficient-funds');
  });

  it('узнаёт недоступный RPC — случай, который был вживую', () => {
    // The exact text returned when a system proxy was tearing connections down.
    expect(
      classifySendError('rpc proxy: error sending request for url (https://ethereum-sepolia-rpc.publicnode.com/)')
    ).toBe('send-rpc-unavailable');
    expect(classifySendError('stauri-rpc.error: 502 Bad Gateway')).toBe('send-rpc-unavailable');
    expect(classifySendError('read: connection reset by peer')).toBe('send-rpc-unavailable');
    expect(classifySendError('context deadline exceeded (timeout)')).toBe('send-rpc-unavailable');
  });

  it('узнаёт неверный адрес', () => {
    expect(classifySendError('invalid recipient address')).toBe('send-invalid-address');
  });

  it('не угадывает там, где причина неизвестна', () => {
    expect(classifySendError('something unexpected happened')).toBe('send-unknown');
    expect(classifySendError('')).toBe('send-unknown');
  });

  it('неверный пароль не путается с нехваткой средств', () => {
    // Both arrive during a send, and the hints for them differ.
    expect(classifySendError('[keystore] incorrect password provided')).not.toBe(
      'send-insufficient-funds'
    );
  });
});
