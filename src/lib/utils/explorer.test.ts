import { describe, it, expect } from 'vitest';
import { explorerTxUrl, explorerAddressUrl } from './explorer';

const HASH = '0x73a222f38c1029ceedf8c3f1af94572ad3ff88abcdef0123456789abcdef0123';

describe('explorerTxUrl', () => {
  it('ведёт на обозреватель той сети, где прошла транзакция', () => {
    // Главная проверка: раньше для любой тестовой сети подставлялся
    // `sepolia.etherscan.io`, и ссылка на Base Sepolia не находила
    // транзакцию, хотя перевод прошёл.
    expect(explorerTxUrl(11155111, HASH)).toBe(
      `https://eth-sepolia.blockscout.com/tx/${HASH}`
    );
    expect(explorerTxUrl(84532, HASH)).toBe(
      `https://base-sepolia.blockscout.com/tx/${HASH}`
    );
    expect(explorerTxUrl(421614, HASH)).toBe(
      `https://arbitrum-sepolia.blockscout.com/tx/${HASH}`
    );
    expect(explorerTxUrl(11155420, HASH)).toBe(
      `https://testnet-explorer.optimism.io/tx/${HASH}`
    );
    expect(explorerTxUrl(560048, HASH)).toBe(
      `https://eth-hoodi.blockscout.com/tx/${HASH}`
    );
  });

  it('ведёт на mainnet-обозреватели', () => {
    expect(explorerTxUrl(1, HASH)).toBe(`https://eth.blockscout.com/tx/${HASH}`);
    expect(explorerTxUrl(8453, HASH)).toBe(`https://base.blockscout.com/tx/${HASH}`);
    expect(explorerTxUrl(42161, HASH)).toBe(`https://arbitrum.blockscout.com/tx/${HASH}`);
    expect(explorerTxUrl(10, HASH)).toBe(`https://explorer.optimism.io/tx/${HASH}`);
  });

  it('не ссылается на Etherscan, который не открывается без VPN', () => {
    // Регрессия: `sepolia.etherscan.io` висит до таймаута, и пользователь
    // видел белую страницу вместо подтверждённой транзакции.
    for (const chainId of [1, 10, 56, 97, 8453, 42161, 84532, 421614, 11155111, 11155420, 560048]) {
      const url = explorerTxUrl(chainId, HASH);
      expect(url, `chain ${chainId}`).not.toBeNull();
      expect(url, `chain ${chainId}`).not.toContain('etherscan.io');
    }
  });

  it('не даёт ссылку для неизвестной сети', () => {
    // Лучше никакой ссылки, чем заведомо нерабочая.
    expect(explorerTxUrl(999999, HASH)).toBeNull();
  });

  it('не даёт ссылку без хэша', () => {
    expect(explorerTxUrl(1, '')).toBeNull();
    expect(explorerTxUrl(1, '   ')).toBeNull();
  });

  it('обрезает пробелы вокруг хэша', () => {
    expect(explorerTxUrl(1, ` ${HASH} `)).toBe(
      `https://eth.blockscout.com/tx/${HASH}`
    );
  });
});

describe('explorerAddressUrl', () => {
  const ADDR = '0xcd8fd2a9f9726729d19f9be57d959942d7eb578c';

  it('строит ссылку на адрес в нужной сети', () => {
    expect(explorerAddressUrl(11155111, ADDR)).toBe(
      `https://eth-sepolia.blockscout.com/address/${ADDR}`
    );
    expect(explorerAddressUrl(84532, ADDR)).toBe(
      `https://base-sepolia.blockscout.com/address/${ADDR}`
    );
  });

  it('не даёт ссылку без адреса или для неизвестной сети', () => {
    expect(explorerAddressUrl(1, '')).toBeNull();
    expect(explorerAddressUrl(1, '   ')).toBeNull();
    expect(explorerAddressUrl(123456, ADDR)).toBeNull();
  });
});
