/**
 * Resolves a readable name for a user or chat.
 *
 * Priority: `displayName` → `ensName` → `alias` → `name` → `compressedKey` → a
 * shortened `id` → `'Unknown'`.
 *
 * @param entity - A contact, user, or chat record.
 * @returns The best available name.
 * @remarks `alias` and `name` are skipped when they hold a raw key rather than
 * a name: a compressed key starts with `zQ3` and an address with `0x`, and
 * showing either where a name belongs tells the reader nothing.
 *
 * The ENS name comes before the alias on purpose. The alias is a random
 * three-word string status-go generates when a profile has no display name
 * ("Responsible Weepy Neonbluehermitcrab"), and it says nothing about the
 * person; a `.eth` name is chosen by the owner and is what they want to be known
 * by.
 */
export function getDisplayName(entity: any): string {
  if (!entity) return 'Unknown';

  // 1. displayName, when set.
  if (entity.displayName && entity.displayName.length > 0) return entity.displayName;

  // 2. ensName, the name the owner chose for themselves.
  if (entity.ensName && entity.ensName.length > 0) return entity.ensName;

  // 3. alias, the three-word name, when present and not a compressed key.
  if (entity.alias && entity.alias.length > 0 && !entity.alias.startsWith('zQ3')) {
    return entity.alias;
  }

  // 4. name, when it is not a truncated key.
  if (entity.name && entity.name.length > 0 && !entity.name.startsWith('0x')) {
    return entity.name;
  }

  // 5. compressedKey / id.
  if (entity.compressedKey) return entity.compressedKey;
  if (entity.id) return entity.id.slice(0, 8) + '...';

  return 'Unknown';
}

/**
 * The X coordinate of a public key, whatever form the key is in.
 *
 * @param key - Compressed key (`0x02…`/`0x03…`, 33 bytes), uncompressed key
 *   (`0x04…`, 65 bytes), or a bare hex string.
 * @returns The 64-hex-character X coordinate, lowercased; the input without the
 *   `0x` prefix when it matches neither form.
 * @remarks
 * status-go uses both forms: a direct chat is identified by the uncompressed
 * key, a channel member by the compressed one, and settings carry the
 * uncompressed one. Comparing the X coordinate identifies the same key in every
 * form; Y is determined by X and the parity prefix, so two different keys cannot
 * share X.
 */
export function publicKeyX(key: string | undefined): string {
  const value = (key || '').toLowerCase().replace(/^0x/, '');
  if (value.length === 130 && value.startsWith('04')) return value.slice(2, 66);
  if (value.length === 66 && (value.startsWith('02') || value.startsWith('03'))) {
    return value.slice(2, 66);
  }
  return value;
}

/**
 * Whether two public keys belong to the same identity.
 *
 * @param a - First key, in any of the forms {@link publicKeyX} accepts.
 * @param b - Second key.
 * @returns `true` when both are present and their X coordinates match.
 * @remarks
 * Needed where one side compares the login key (uncompressed, from settings)
 * with a message's `from` (compressed inside a channel): a plain string compare
 * fails there, and the own message was attributed to a contact.
 */
export function samePublicKey(a: string | undefined, b: string | undefined): boolean {
  const x = publicKeyX(a);
  return x.length > 0 && x === publicKeyX(b);
}


/**
 * Replaces public keys in a message body with readable names.
 *
 * @param text - The message text.
 * @param contacts - Known contacts, used to look a name up by key.
 * @returns The text with every matched key replaced by a contact name, or left
 * as it was when no contact matches.
 * @remarks A key is matched as `0x` followed by 4 to 64 hex characters, with an
 * optional trailing `...`; a match is resolved against contacts whose `id`
 * starts with the key. Both hex and base58 keys exist in Status, and only the
 * `0x` form is rewritten here.
 */
export function formatMessageText(text: string, contacts: any[] = []): string {
  if (!text) return '';

  // Matches 0x plus 4-64 hex characters, with an optional trailing "...".
  const keyRegex = /0x[a-fA-F0-9]{4,64}(?:\.\.\.)?/g;

  return text.replace(keyRegex, (match) => {
    const cleanKey = match.replace('...', '');

    // Find a contact whose id starts with cleanKey.
    const contact = contacts.find(c => c.id.startsWith(cleanKey));
    if (contact) {
      return getDisplayName(contact);
    }
    return match;
  });
}
