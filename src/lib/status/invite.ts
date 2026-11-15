/**
 * Channel invite link builder, the mirror image of the parser in `messaging.ts`.
 *
 * The format matches `Chat.DeepLink()` in status-go for a community channel:
 *
 *   status.app/cc/<channel UUID>#<multibase base58btc community key>
 *
 * The community key is a compressed secp256k1 key with the multicodec prefix
 * `0xe7 0x01`, encoded in base58btc with a leading `z`. status-go encodes it the
 * same way (`SerializePublicKey`), so a link built here opens in SIM.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SECP256K1_PUB_PREFIX = [0xe7, 0x01];

/**
 * Encodes a compressed public key as a multibase base58btc string.
 *
 * @param hex - Compressed public key as `0x`-hex.
 * @returns The same key in multibase base58btc, with the `z` prefix.
 * @throws When the key is not 33 bytes, the length of a compressed key.
 * @remarks
 * The byte order is big-endian, as base58btc requires; the `0xe7 0x01`
 * multicodec prefix is prepended before the key bytes.
 */
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
  // Leading zero bytes would be encoded as ones; the prefix here is non-zero,
  // so no extra handling is needed.
  return 'z' + out;
}

/**
 * Builds an invite link for a channel.
 *
 * @param channelId - UUID of the channel inside its community, without the
 * community prefix.
 * @param communityKeyHex - Community key as `0x`-hex of a compressed public key.
 * @returns HTTPS invite link that status-go clients understand.
 */
export function channelInviteLink(channelId: string, communityKeyHex: string): string {
  return `https://status.app/cc/${channelId}#${hexToBase58Key(communityKeyHex)}`;
}
