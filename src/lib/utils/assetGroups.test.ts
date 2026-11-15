import { describe, it, expect } from 'vitest';
import {
  chainGroup,
  normalizeSymbol,
  groupAssets,
  groupLabel,
} from './assetGroups';
import type { WalletToken } from '$lib/stores/walletStore.svelte';

function token(overrides: Partial<WalletToken> = {}): WalletToken {
  return {
    symbol: 'ETH',
    decimals: 18,
    balance: '0',
    chainId: 11155111,
    tokenAddress: '0x0000000000000000000000000000000000000000',
    hasError: false,
    ...overrides,
  };
}

describe('chainGroup', () => {
  it('складывает mainnet-сети в EVM', () => {
    for (const id of [1, 10, 42161, 8453]) {
      expect(chainGroup(id)).toBe('EVM');
    }
  });

  it('выделяет BNB Chain в свою группу', () => {
    expect(chainGroup(56)).toBe('BSC');
  });

  it('каждую тестовую сеть держит отдельно', () => {
    // A single catch-all group would collapse these five into one row, though
    // each is a different asset on a different network.
    const testnets = [11155111, 84532, 421614, 11155420, 560048];
    const groups = testnets.map(chainGroup);
    expect(new Set(groups).size).toBe(testnets.length);
    expect(groups).not.toContain('OTHER');
  });

  it('BSC Testnet не смешивает с BNB Chain', () => {
    expect(chainGroup(97)).not.toBe(chainGroup(56));
  });

  it('неизвестную сеть не складывает с другими', () => {
    expect(chainGroup(999999)).toBe('999999');
  });
});

describe('normalizeSymbol', () => {
  it('убирает невидимые символы и приводит к верхнему регистру', () => {
    expect(normalizeSymbol('​eth ')).toBe('ETH');
    expect(normalizeSymbol('usdc')).toBe('USDC');
  });

  it('переживает пустое значение', () => {
    expect(normalizeSymbol('')).toBe('');
    expect(normalizeSymbol(undefined as unknown as string)).toBe('');
  });
});

describe('groupAssets', () => {
  it('складывает ETH между mainnet-сетями', () => {
    const groups = groupAssets([
      token({ chainId: 1, balance: '1000' }),
      token({ chainId: 10, balance: '2000' }),
      token({ chainId: 8453, balance: '3000' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].totalBalance).toBe(6000n);
    expect(groups[0].chains.sort()).toEqual([1, 10, 8453]);
    expect(groups[0].group).toBe('EVM');
  });

  it('держит тестовые сети отдельными строками', () => {
    // One row per test network, not a single combined Assets row.
    const groups = groupAssets([
      token({ chainId: 11155111, balance: '100' }),
      token({ chainId: 84532, balance: '200' }),
      token({ chainId: 421614, balance: '300' }),
      token({ chainId: 11155420, balance: '400' }),
      token({ chainId: 560048, balance: '500' }),
    ]);

    expect(groups).toHaveLength(5);
    expect(groups.every((g) => g.totalBalance > 0n)).toBe(true);
    // No total is summed from more than one network.
    expect(groups.map((g) => g.chains.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('не суммирует разные символы', () => {
    const groups = groupAssets([
      token({ chainId: 11155111, symbol: 'ETH' }),
      token({ chainId: 11155111, symbol: 'USDC', decimals: 6 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('не суммирует одинаковые символы с разной точностью', () => {
    // USDC at 6 and at 18 decimals are different units; their sum means nothing.
    const groups = groupAssets([
      token({ chainId: 1, symbol: 'USDC', decimals: 6, balance: '1000000' }),
      token({ chainId: 1, symbol: 'USDC', decimals: 18, balance: '1000000' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.decimals).sort((a, b) => a - b)).toEqual([6, 18]);
  });

  it('сортирует ненулевые балансы перед нулевыми', () => {
    const groups = groupAssets([
      token({ chainId: 1, symbol: 'DAI', balance: '0' }),
      token({ chainId: 1, symbol: 'ETH', balance: '5' }),
      token({ chainId: 1, symbol: 'USDC', decimals: 6, balance: '0' }),
    ]);
    expect(groups.map((g) => g.symbol)).toEqual(['ETH', 'DAI', 'USDC']);
  });

  it('помечает группу ошибкой, если хоть один токен её не получил', () => {
    const groups = groupAssets([
      token({ chainId: 1, balance: '10' }),
      token({ chainId: 10, balance: '0', hasError: true }),
    ]);
    expect(groups[0].hasError).toBe(true);
  });

  it('не падает на испорченном балансе', () => {
    const groups = groupAssets([token({ balance: 'не число' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].hasError).toBe(true);
    expect(groups[0].totalBalance).toBe(0n);
  });

  it('пустой список даёт пустой результат', () => {
    expect(groupAssets([])).toEqual([]);
  });
});

describe('groupLabel', () => {
  it('подписывает EVM и BSC как в Status', () => {
    const [g] = groupAssets([token({ chainId: 1 })]);
    expect(groupLabel(g)).toBe('ETH (EVM)');

    const [b] = groupAssets([token({ chainId: 56, symbol: 'BNB' })]);
    expect(groupLabel(b)).toBe('BNB (BSC)');
  });

  it('называет тестовую сеть по имени', () => {
    // Without the network name, five different test ETH look identical.
    const groups = groupAssets([
      token({ chainId: 11155111 }),
      token({ chainId: 84532 }),
      token({ chainId: 421614 }),
    ]);
    const labels = groups.map(groupLabel);
    expect(labels).toContain('ETH (Sepolia)');
    expect(labels).toContain('ETH (Base Sepolia)');
    expect(labels).toContain('ETH (Arbitrum Sepolia)');
  });

  it('для неизвестной сети показывает только символ', () => {
    const [g] = groupAssets([token({ chainId: 999999 })]);
    expect(groupLabel(g)).toBe('ETH');
  });
});
