import { describe, it, expect } from 'vitest';
import { displayNameError } from './displayName';

describe('displayNameError — mirrors status-go ValidateDisplayName', () => {
  it('accepts names status-go accepts', () => {
    expect(displayNameError('New stauri user')).toBeNull();
    expect(displayNameError('Константин')).toBeNull();
    expect(displayNameError('magnus-redkin')).toBeNull();
    expect(displayNameError('user_name 12')).toBeNull();
  });

  it('rejects a name with a symbol, the case that broke the contact update', () => {
    // Seen in the SIM log: "Константин !" was dropped by the receiver with
    // "only letters, numbers, underscores and hyphens allowed".
    expect(displayNameError('Константин !')).toBe(
      'Only letters, digits, spaces, hyphens and underscores'
    );
  });

  it('enforces the length bounds, counted in characters', () => {
    expect(displayNameError('abcd')).toBe('Name must be 5 to 24 characters');
    expect(displayNameError('a'.repeat(25))).toBe('Name must be 5 to 24 characters');
    // 24 Cyrillic characters: one UTF-16 unit each here, but the count must not
    // depend on that.
    expect(displayNameError('я'.repeat(24))).toBeNull();
  });

  it('rejects the eth suffixes', () => {
    expect(displayNameError('someone.eth')).not.toBeNull();
    expect(displayNameError('someone-eth')).not.toBeNull();
  });

  it('treats an empty name as "no name"', () => {
    expect(displayNameError('')).toBeNull();
    expect(displayNameError('   ')).toBeNull();
  });
});
