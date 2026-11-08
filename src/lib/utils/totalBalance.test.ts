import { describe, it, expect } from 'vitest';
import {
  totalBalance,
  formatTotal,
  priceKey,
  MAINNET_CHAINS,
} from './totalBalance';
import type { WalletToken } from '$lib/stores/walletStore.svelte';

function token(over: Partial<WalletToken> & { symbol: string }): WalletToken {
  return {
    decimals: 18,
    balance: '0',
    chainId: 1,
    tokenAddress: '0x0000000000000000000000000000000000000000',
    hasError: false,
    ...over,
  };
}

describe('MAINNET_CHAINS', () => {
  it('includes production networks only', () => {
    // Компаратор обязателен: `.sort()` по умолчанию сравнивает строки, и
    // [1, 10, 42161, 56, 8453] выглядело бы как ошибка в наборе.
    expect([...MAINNET_CHAINS].sort((a, b) => a - b)).toEqual([1, 10, 56, 8453, 42161]);
  });

  it('excludes test networks', () => {
    for (const chain of [11155111, 84532, 421614, 560048, 11155420, 97]) {
      expect(MAINNET_CHAINS.has(chain)).toBe(false);
    }
  });
});

describe('priceKey', () => {
  it('uses the status-go key format', () => {
    // status-go строит ключ как "<chainId>-<адрес строчными>".
    // Двоеточие вместо дефиса дало бы пустую цену без всякой ошибки.
    expect(priceKey(1, '0x744D70FDBE2BA4CF95131626614A1763DF805B9E')).toBe(
      '1-0x744d70fdbe2ba4cf95131626614a1763df805b9e'
    );
  });
});

describe('totalBalance', () => {
  it('sums mainnet tokens using their prices', () => {
    const result = totalBalance(
      [
        token({ symbol: 'ETH', balance: '2000000000000000000' }), // 2 ETH
        token({
          symbol: 'USDC',
          balance: '5000000',
          decimals: 6,
          tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        }),
      ],
      {
        '1-0x0000000000000000000000000000000000000000': 2000,
        '1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
      }
    );

    // 2 * 2000 + 5 * 1 = 4005
    expect(result.total).toBeCloseTo(4005, 6);
    expect(result.priced).toBe(2);
    expect(result.unpriced).toHaveLength(0);
    expect(result.isPartial).toBe(false);
  });

  it('ignores test networks even when they have prices', () => {
    const result = totalBalance(
      [
        token({ symbol: 'ETH', balance: '1000000000000000000' }),
        // Sepolia ETH: не конвертируется в настоящий ETH.
        token({ symbol: 'ETH', balance: '50000000000000000000', chainId: 11155111 }),
      ],
      { '1-0x0000000000000000000000000000000000000000': 2000 }
    );

    expect(result.total).toBeCloseTo(2000, 6);
    expect(result.unpriced).toHaveLength(0);
  });

  it('reports tokens without a price instead of dropping them', () => {
    const result = totalBalance(
      [
        token({ symbol: 'ETH', balance: '1000000000000000000' }),
        token({
          symbol: 'NEW',
          balance: '1000000000000000000',
          tokenAddress: '0x1111111111111111111111111111111111111111',
        }),
      ],
      { '1-0x0000000000000000000000000000000000000000': 2000 }
    );

    expect(result.total).toBeCloseTo(2000, 6);
    expect(result.isPartial).toBe(true);
    expect(result.unpriced).toHaveLength(1);
    expect(result.unpriced[0].symbol).toBe('NEW');
  });

  it('skips tokens whose RPC call failed', () => {
    // hasError — «не знаем баланс», а не «ноль».
    const result = totalBalance(
      [token({ symbol: 'ETH', balance: '1000000000000000000', hasError: true })],
      { '1-0x0000000000000000000000000000000000000000': 2000 }
    );

    expect(result.total).toBe(0);
    expect(result.priced).toBe(0);
    expect(result.unpriced).toHaveLength(0);
  });

  it('handles zero balances without counting them', () => {
    const result = totalBalance(
      [token({ symbol: 'ETH', balance: '0' })],
      { '1-0x0000000000000000000000000000000000000000': 2000 }
    );

    expect(result.total).toBe(0);
    expect(result.priced).toBe(0);
    expect(result.isPartial).toBe(false);
  });

  it('keeps precision beyond 15 digits', () => {
    // 1.234567890123456789 ETH: через number это округлилось бы.
    const result = totalBalance(
      [token({ symbol: 'ETH', balance: '1234567890123456789' })],
      { '1-0x0000000000000000000000000000000000000000': 1 }
    );

    expect(result.total).toBeCloseTo(1.234567890123456, 9);
  });

  it('treats a non-numeric balance as absent rather than crashing', () => {
    const result = totalBalance(
      [token({ symbol: 'ETH', balance: 'garbage' })],
      { '1-0x0000000000000000000000000000000000000000': 2000 }
    );

    expect(result.total).toBe(0);
    expect(result.priced).toBe(0);
  });

  it('sums the same token across mainnet chains separately', () => {
    const result = totalBalance(
      [
        token({ symbol: 'ETH', balance: '1000000000000000000', chainId: 1 }),
        token({ symbol: 'ETH', balance: '3000000000000000000', chainId: 42161 }),
      ],
      {
        '1-0x0000000000000000000000000000000000000000': 2000,
        '42161-0x0000000000000000000000000000000000000000': 2000,
      }
    );

    // 1 ETH + 3 ETH по 2000
    expect(result.total).toBeCloseTo(8000, 6);
    expect(result.priced).toBe(2);
  });
});

describe('formatTotal', () => {
  it('marks the value as approximate', () => {
    expect(formatTotal(1234)).toContain('≈');
  });

  it('drops cents for large sums', () => {
    expect(formatTotal(1234.56)).toBe('≈ $1,235');
  });

  it('keeps cents for small sums', () => {
    expect(formatTotal(12.5)).toBe('≈ $12.5');
  });

  it('renders zero', () => {
    expect(formatTotal(0)).toBe('≈ $0');
  });

  it('does not print Infinity or NaN', () => {
    expect(formatTotal(Number.NaN)).toBe('≈ $0');
    expect(formatTotal(Number.POSITIVE_INFINITY)).toBe('≈ $0');
  });
});
