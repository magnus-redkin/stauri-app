import { describe, it, expect } from 'vitest';
import { withKindPrefix, parseKind, KIND_JOINS_BY_REQUEST } from './channelKind';

describe('тип канала в описании', () => {
  it('тип записывается префиксом и читается обратно без потери описания', () => {
    const text = withKindPrefix('issues', 'Баги и задачи');
    expect(text).toBe('[issues] Баги и задачи');
    expect(parseKind(text)).toEqual({ kind: 'issues', description: 'Баги и задачи' });
  });

  it('канал без префикса считается по заявке (безопасный вариант)', () => {
    expect(parseKind('Просто описание')).toEqual({ kind: 'request', description: 'Просто описание' });
  });

  it('вступление: news открыт, остальные типы — по заявке', () => {
    expect(KIND_JOINS_BY_REQUEST.news).toBe(false);
    expect(KIND_JOINS_BY_REQUEST.request).toBe(true);
    expect(KIND_JOINS_BY_REQUEST.issues).toBe(true);
  });
});
