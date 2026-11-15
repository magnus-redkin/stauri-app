import { describe, it, expect } from 'vitest';
import { canRecord, canComment, ROLE_OWNER } from './channelRights';

describe('запись в канал зависит от типа', () => {
  it('news: запись только у автора', () => {
    expect(canRecord('news', ROLE_OWNER)).toBe(true);
    expect(canRecord('news', 4)).toBe(false); // admin, not the author
    expect(canRecord('news', 0)).toBe(false); // member
    expect(canRecord('news', undefined)).toBe(false); // no role came through, deny
  });

  it('request: запись только у автора', () => {
    expect(canRecord('request', ROLE_OWNER)).toBe(true);
    expect(canRecord('request', 0)).toBe(false);
  });

  it('issues: запись у всех, кому разрешено писать', () => {
    expect(canRecord('issues', ROLE_OWNER)).toBe(true);
    expect(canRecord('issues', 0)).toBe(true);
    expect(canRecord('issues', undefined)).toBe(true);
  });

  it('1-1 чат (тип не задан): правило канала не применяется', () => {
    expect(canRecord(undefined, 0)).toBe(true);
  });
});

describe('комментарии', () => {
  it('доступны всем, кому разрешено писать в канал', () => {
    expect(canComment(true)).toBe(true);
    expect(canComment(undefined)).toBe(true);
    expect(canComment(false)).toBe(false);
  });
});
