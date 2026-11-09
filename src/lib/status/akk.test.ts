import { describe, it, expect } from 'vitest';
import { validateChannelInput } from './akk';

describe('validateChannelInput: ссылка вместо имени', () => {
  it('подсказывает вставить ссылку в поиск, а не пишет «слишком длинное имя»', () => {
    const msg = validateChannelInput('https://status.app/cc/abc#zQ3sh', 'описание');
    expect(msg).toContain('invite link');
    expect(msg).not.toContain('longer');
  });

  it('обычное имя проходит, длинное — отклоняется по байтам', () => {
    expect(validateChannelInput('N5', 'описание')).toBeNull();
    expect(validateChannelInput('а'.repeat(16), 'описание')).toContain('bytes');
  });
});
