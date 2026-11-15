/**
 * Resolves a readable name for a user or chat.
 *
 * Priority: `displayName` → `alias` → `name` → `compressedKey` → a shortened
 * `id` → `'Unknown'`.
 *
 * @param entity - A contact, user, or chat record.
 * @returns The best available name.
 * @remarks `alias` and `name` are skipped when they hold a raw key rather than
 * a name: a compressed key starts with `zQ3` and an address with `0x`, and
 * showing either where a name belongs tells the reader nothing.
 */
export function getDisplayName(entity: any): string {
  if (!entity) return 'Unknown';

  // 1. displayName, when set.
  if (entity.displayName && entity.displayName.length > 0) return entity.displayName;

  // 2. alias, the three-word name, when present and not a compressed key.
  if (entity.alias && entity.alias.length > 0 && !entity.alias.startsWith('zQ3')) {
    return entity.alias;
  }

  // 3. name, when it is not a truncated key.
  if (entity.name && entity.name.length > 0 && !entity.name.startsWith('0x')) {
    return entity.name;
  }

  // 4. compressedKey / id.
  if (entity.compressedKey) return entity.compressedKey;
  if (entity.id) return entity.id.slice(0, 8) + '...';

  return 'Unknown';
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
