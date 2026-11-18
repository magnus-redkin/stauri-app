/**
 * Profile actions that need more than an RPC call.
 *
 * The picture and the password change both go through dedicated Rust commands
 * (`src-tauri/src/profile.rs`). The avatar cannot be an ordinary RPC: status-go
 * wants a *file path*, and the webview has no filesystem. The password change is a
 * direct status-go export, not an RPC method.
 *
 * Both carry secrets or payload data, so nothing here is logged beyond lengths and
 * outcomes — the backend does that tracing itself.
 */

import { invoke } from '@tauri-apps/api/core';
import { i18n } from '$lib/i18n';
import { formatError } from '$lib/utils/errors';
import { info } from '$lib/utils/log';

/** Thumbnail side that a picture should at least have to stay sharp, in pixels. */
export const AVATAR_MIN_SIDE = 80;

/** Largest file accepted, in bytes. status-go re-encodes to ~350 KB itself. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

/** Types status-go can decode (`internal/images/decode.go`). */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** What the backend reports after storing a picture. */
export interface AvatarSaved {
  kinds: string[];
  width: number;
  height: number;
}

/**
 * Reads a file as a data URL.
 *
 * @param file - File chosen in the picker.
 * @returns `data:<type>;base64,…`
 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('cannot read the file'));
    reader.readAsDataURL(file);
  });
}

/** Width and height of an image file, measured by the browser. */
function measure(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('not an image'));
    };
    img.src = url;
  });
}

/**
 * Checks a chosen file against what this app and status-go accept.
 *
 * @param file - File from the picker.
 * @param measureSize - Reads the pixel size; injectable so the rule can be tested
 *   without a browser decoder.
 * @returns A locale key for the problem, or `null` when the file is usable.
 *
 * @remarks
 * The rules are checked here rather than left to status-go so a wrong file is
 * refused with a sentence the user understands, instead of a decode error from
 * Go. The same three formats are the ones status-go decodes; the size limit is
 * this app's own, since status-go would happily decode a 20 MB photo and shrink
 * it, having first moved it across the IPC boundary.
 */
export async function avatarProblem(
  file: File,
  measureSize: (f: File) => Promise<{ width: number; height: number }> = measure
): Promise<string | null> {
  if (!AVATAR_TYPES.includes(file.type)) {
    return 'Only PNG, JPEG and WebP images are supported';
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return 'The image is larger than 5 MB';
  }
  try {
    const { width, height } = await measureSize(file);
    if (Math.min(width, height) < AVATAR_MIN_SIDE) {
      return `The image is smaller than ${AVATAR_MIN_SIDE}×${AVATAR_MIN_SIDE} pixels`;
    }
  } catch {
    return 'The file could not be read as an image';
  }
  return null;
}

/**
 * Uploads a picture as the profile avatar.
 *
 * @param file - Already validated file.
 * @returns What status-go stored.
 */
export async function storeAvatar(file: File): Promise<AvatarSaved> {
  const image = await readAsDataUrl(file);
  info(`[profile] storeAvatar: bytes=${file.size} type=${file.type}`);
  return await invoke<AvatarSaved>('store_avatar', {
    input: { image, media_type: file.type },
  });
}

/**
 * Reads the current avatar.
 *
 * @returns A data URL, or `null` when the profile has no picture.
 * @remarks
 * The RPC reply carries no image bytes (status-go drops `payload` from its JSON),
 * so Rust fetches the picture from the local media server and inlines it. That is
 * why the result is a data URL rather than a link the webview would have to load.
 */
export async function loadAvatar(): Promise<string | null> {
  try {
    return await invoke<string | null>('get_avatar');
  } catch (e) {
    // A missing picture is not an error worth a message: the profile shows initials
    // instead, and the rest of the page works.
    info(`[profile] loadAvatar failed: ${formatError(e)}`);
    return null;
  }
}

/**
 * Changes the profile password.
 *
 * @param current - Password the profile is encrypted with now.
 * @param next - New password; the caller has already checked it against the rules
 *   and against its confirmation.
 * @remarks
 * status-go verifies `current` itself, so a wrong one comes back as an error rather
 * than being ignored. Only the re-wrap happens: databases stay as they are, so no
 * restart is needed.
 */
export async function changePassword(current: string, next: string): Promise<void> {
  info(`[profile] changePassword: currentLen=${current.length} newLen=${next.length}`);
  await invoke('change_password', { input: { current, new: next } });
}

/** Message to show for a failed password change. */
export function changePasswordError(e: unknown): string {
  const text = formatError(e);
  if (text.includes('incorrect current password')) {
    return i18n.t('The current password is incorrect');
  }
  return text;
}
