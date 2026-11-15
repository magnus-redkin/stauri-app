import { describe, it, expect } from 'vitest';
import { formatBalance } from './format';

describe('formatBalance', () => {
  it('должен возвращать "0" для нулевого баланса', () => {
    expect(formatBalance('0')).toBe('0');
    expect(formatBalance(undefined)).toBe('0');
    expect(formatBalance(null)).toBe('0');
  });

  it('должен корректно обрабатывать целые числа', () => {
    expect(formatBalance('1000000000000000000')).toBe('1');
    expect(formatBalance('5000000000000000000')).toBe('5');
  });

  it('должен корректно обрабатывать дробные числа', () => {
    expect(formatBalance('1500000000000000000')).toBe('1.5');
    expect(formatBalance('100000000000000')).toBe('0.0001');
  });

  it('должен убирать лишние нули в конце дробной части', () => {
    expect(formatBalance('1500000000000000000')).toBe('1.5');
  });

  it('должен поддерживать другие decimals (например, USDC с 6 знаками)', () => {
    expect(formatBalance('1000000', 6)).toBe('1');
    expect(formatBalance('1500000', 6)).toBe('1.5');
  });

  it('должен ограничивать количество знаков после запятой', () => {
    // 1 wei at 18 decimals is 0.000000000000000001 — 18 fractional digits.
    // With maxFractionDigits = 6 only "0.000000" remains, which is "0".
    expect(formatBalance('1', 18, 6)).toBe('0');

    // 0.123456789 ETH truncated at 6 digits gives "0.123456".
    expect(formatBalance('123456789000000000', 18, 6)).toBe('0.123456');
  });

  it('должен выбрасывать ошибку при некорректном вводе', () => {
    expect(() => formatBalance('invalid')).toThrow();
    expect(() => formatBalance('1.5')).toThrow(); // BigInt не принимает точки
  });

  it('должен использовать 18 decimals при некорректном значении decimals', () => {
    // decimals = -1 is invalid, so 18 is used.
    expect(formatBalance('1000000000000000000', -1)).toBe('1');
  });
});
