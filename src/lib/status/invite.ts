/**
 * Построение ссылки на канал — зеркало разбора в `messaging.ts`.
 *
 * Формат совпадает с `Chat.DeepLink()` в status-go для канала сообщества:
 *
 *   status.app/cc/<UUID канала>#<multibase base58btc ключа сообщества>
 *
 * Ключ сообщества — сжатый secp256k1 с multicodec-префиксом `0xe7 0x01`,
 * закодированный в base58btc с ведущим `z`. Так же его кодирует status-go
 * (`SerializePublicKey`), поэтому ссылка из Stauri открывается в SIM.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SECP256K1_PUB_PREFIX = [0xe7, 0x01];

/** `0x`-hex сжатого публичного ключа → multibase base58btc. */
export function hexToBase58Key(hex: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== 66) throw new Error('community key must be a 33-byte compressed key');
  const bytes = [...SECP256K1_PUB_PREFIX, ...(clean.match(/../g) ?? []).map((b) => parseInt(b, 16))];

  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  // Ведущие нулевые байты кодируются единицами; здесь префикс ненулевой,
  // поэтому дополнительной обработки не нужно.
  return 'z' + out;
}

/**
 * Ссылка-приглашение на канал.
 *
 * @param channelId UUID канала внутри сообщества (без префикса сообщества).
 * @param communityKeyHex ключ сообщества, `0x`-hex сжатого публичного ключа.
 */
export function channelInviteLink(channelId: string, communityKeyHex: string): string {
  return `https://status.app/cc/${channelId}#${hexToBase58Key(communityKeyHex)}`;
}
