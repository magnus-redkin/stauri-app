import { describe, it, expect } from 'vitest';
import { channelInviteLink, hexToBase58Key } from './invite';
import { channelIdFromInvite, communityIdFromInvite } from './messaging';

// Ключ из ссылки, которую прислал пользователь (SIM), — реальный образец.
const KEY_HEX = '0x03ddf4c625afcbf7fb9fe189e43b9158b70e8f01fe968e41ae49f258aa9b7d1400';
const KEY_B58 = 'zQ3shuaXi1bQ6iVowkgm6eUtt5PPToUUpifePDvereeupioks';
const CHANNEL = '1f7b1c4e-3a2d-4b5e-8c9f-0a1b2c3d4e5f';

describe('hexToBase58Key', () => {
  it('кодирует ключ так же, как status-go в реальной ссылке', () => {
    expect(hexToBase58Key(KEY_HEX)).toBe(KEY_B58);
  });

  it('отвергает ключ неверной длины', () => {
    expect(() => hexToBase58Key('0x1234')).toThrow();
  });
});

describe('channelInviteLink', () => {
  it('собирает ссылку, которую разбирает приём приглашений', () => {
    const link = channelInviteLink(CHANNEL, KEY_HEX);
    expect(link).toBe(`https://status.app/cc/${CHANNEL}#${KEY_B58}`);
    // Тот же путь, что у приглашения от пользователя: UUID и ключ восстанавливаются.
    expect(channelIdFromInvite(link)).toBe(CHANNEL);
    expect(communityIdFromInvite(link)).toBe(KEY_HEX);
  });
});
