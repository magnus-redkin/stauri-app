// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { avatarProblem, AVATAR_MAX_BYTES, AVATAR_MIN_SIDE } from './profile';

/**
 * Avatar checks that run before anything crosses the IPC boundary.
 *
 * The pixel size is injected: a headless browser does not decode images, so a real
 * measurement would test the environment rather than the rule.
 */
describe('avatarProblem', () => {
  function file(type: string, size: number): File {
    // A buffer of the requested length, without filling it: only `size` is read.
    return new File([new Uint8Array(size)], 'avatar', { type });
  }

  /** Stand-in for the browser measurement. */
  const size = (width: number, height: number) => async () => ({ width, height });

  it('принимает PNG 512×512', async () => {
    expect(await avatarProblem(file('image/png', 1024), size(512, 512))).toBeNull();
  });

  it('принимает JPEG и WebP', async () => {
    expect(await avatarProblem(file('image/jpeg', 1024), size(800, 600))).toBeNull();
    expect(await avatarProblem(file('image/webp', 1024), size(800, 600))).toBeNull();
  });

  it('отклоняет PDF', async () => {
    expect(await avatarProblem(file('application/pdf', 1024), size(512, 512))).toContain(
      'PNG, JPEG and WebP'
    );
  });

  it('отклоняет файл больше 5 МБ', async () => {
    const problem = await avatarProblem(file('image/png', AVATAR_MAX_BYTES + 1), size(512, 512));
    expect(problem).toContain('5 MB');
  });

  it('отклоняет изображение меньше минимальной стороны', async () => {
    const problem = await avatarProblem(
      file('image/png', 1024),
      size(AVATAR_MIN_SIDE - 1, 512)
    );
    expect(problem).toContain(`smaller than ${AVATAR_MIN_SIDE}`);
  });

  it('отклоняет файл, который не читается как изображение', async () => {
    const failing = async () => {
      throw new Error('not an image');
    };
    expect(await avatarProblem(file('image/png', 1024), failing)).toContain(
      'could not be read as an image'
    );
  });
});
