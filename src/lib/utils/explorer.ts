/**
 * Адреса обозревателей для ссылки на транзакцию и адрес.
 *
 * ## Почему не Etherscan
 *
 * `etherscan.io` и его testnet-домены (`sepolia.etherscan.io`,
 * `hoodi.etherscan.io`, `optimistic.etherscan.io`) из этой сети не открываются
 * вовсе — соединение висит до таймаута. Проверено вживую: `code=000`,
 * 12 секунд, при этом `eth.blockscout.com` и
 * `eth-sepolia.blockscout.com` отвечают за 0.3 с. Ссылка на Etherscan
 * открывала пользователю белую страницу, хотя транзакция была подтверждена.
 *
 * Поэтому основным источником выбран Blockscout: он открывается без VPN и
 * даёт ту же информацию. У Optimism свой обозреватель (`explorer.optimism.io`,
 * `optimism.blockscout.com` редиректит туда).
 *
 * ## Про BNB Chain
 *
 * У BSC своего Blockscout нет (`bsc.blockscout.com` → 404), поэтому там
 * остаётся BscScan. Он отдаёт `403` скриптам (защита Cloudflare), но в
 * браузере открывается — ссылку даём, это не наша ошибка.
 *
 * ## Про неизвестную сеть
 *
 * Возвращаем `null`: лучше не дать ссылку, чем дать заведомо нерабочую и
 * заставить человека решить, что транзакция не отправилась.
 */

/** Базовый адрес обозревателя для каждой поддерживаемой сети. */
const EXPLORERS: Record<number, string> = {
  // mainnet
  1: 'https://eth.blockscout.com',
  10: 'https://explorer.optimism.io',
  56: 'https://bscscan.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  // тестовые
  97: 'https://testnet.bscscan.com',
  560048: 'https://eth-hoodi.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
  11155420: 'https://testnet-explorer.optimism.io',
  421614: 'https://arbitrum-sepolia.blockscout.com',
};

/**
 * Ссылка на транзакцию.
 *
 * @returns адрес или `null`, если для сети обозреватель неизвестен.
 */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  // Сначала обрезаем, потом проверяем: строка из одних пробелов проходит
  // проверку на пустоту, но хэшем не является — ссылка получилась бы
  // заведомо нерабочей (`/tx/`).
  const hash = txHash.trim();
  if (!hash) return null;
  const base = EXPLORERS[chainId];
  if (!base) return null;
  return `${base}/tx/${hash}`;
}

/** Ссылка на адрес — для экрана получения и списка аккаунтов. */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const value = address.trim();
  if (!value) return null;
  const base = EXPLORERS[chainId];
  if (!base) return null;
  return `${base}/address/${value}`;
}
