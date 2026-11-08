/**
 * Общий баланс аккаунта по основным сетям.
 *
 * ## Почему только mainnet
 *
 * Один и тот же ETH существует в пяти тестовых сетях как пять отдельных
 * записей. Сложить их с mainnet — значит показать сумму, которой нигде нет:
 * сеполия-ETH не конвертируется в ETH. Поэтому тестовые сети в итог не входят
 * совсем, а не «входят с нулевой ценой».
 *
 * ## Почему «≈»
 *
 * Сумма получается из курсов, а курс — приблизительная величина: он меняется
 * каждую минуту, а часть токенов может быть без цены вовсе (новый токен, тестовая
 * сеть, отсутствие в CoinGecko). Поэтому итог всегда приблизительный, и
 * `unpriced` говорит, сколько токенов в него не вошло.
 *
 * ## Почему считается по `bigint`, а не по числу
 *
 * Баланс приходит в минимальных единицах. `1e18` в `number` теряет точность
 * уже на 16 значащих цифрах, поэтому делим BigInt на 10^decimals и только
 * потом переводим в число — для показательной суммы этого достаточно.
 */

import type { WalletToken } from '$lib/stores/walletStore.svelte';

/**
 * Сети, которые попадают в итог.
 *
 * Только mainnet: Ethereum, Optimism, BNB Chain, Base, Arbitrum. Список
 * совпадает с `EVM_CHAINS` + `BSC_CHAINS` в `assetGroups.ts`, но задан
 * отдельно намеренно: то множество отвечает на вопрос «что считать одним
 * активом», а это — «что считать деньгами».
 */
export const MAINNET_CHAINS: ReadonlySet<number> = new Set([1, 10, 56, 8453, 42161]);

/** Баланс в основных единицах как число (приблизительно, для показа). */
function toNumber(balance: bigint, decimals: number): number {
  if (decimals <= 0) return Number(balance);
  const divisor = 10n ** BigInt(decimals);
  const whole = balance / divisor;
  const fraction = balance % divisor;
  // Остаток переводим отдельно: иначе деление BigInt отбросило бы его.
  return Number(whole) + Number(fraction) / Number(divisor);
}

/** Ключ токена в том виде, в каком его ждёт `wallet_fetchPrices`. */
export function priceKey(chainId: number, tokenAddress: string): string {
  return `${chainId}-${tokenAddress.toLowerCase()}`;
}

/** Строка к балансу без цены — такие надо перечислить отдельно. */
export interface UnpricedToken {
  symbol: string;
  chainId: number;
  /** Баланс в минимальных единицах. */
  balance: bigint;
  decimals: number;
}

export interface TotalBalance {
  /** Сумма в валюте цен. `0`, если цен нет вовсе. */
  total: number;
  /** Сколько токенов вошло в сумму. */
  priced: number;
  /** Токены с ненулевым балансом, но без цены. */
  unpriced: UnpricedToken[];
  /** Часть активов не вошла в сумму — итог неполный. */
  isPartial: boolean;
}

/**
 * Считает итог.
 *
 * `prices` — плоская карта `chainId-адрес` → цена, как её отдаёт
 * `getTokenPrices`. Токен без цены не выбрасывается молча: он попадает в
 * `unpriced`, потому что иначе «итог 0» при полном кошельке выглядел бы
 * поломкой.
 */
export function totalBalance(
  tokens: WalletToken[],
  prices: Record<string, number>
): TotalBalance {
  let total = 0;
  let priced = 0;
  const unpriced: UnpricedToken[] = [];

  for (const token of tokens) {
    if (!MAINNET_CHAINS.has(token.chainId)) continue;
    // Токен, по которому RPC не ответил, — не ноль: его просто не знаем.
    if (token.hasError) continue;

    let balance: bigint;
    try {
      balance = BigInt(token.balance || '0');
    } catch {
      continue;
    }
    if (balance === 0n) continue;

    const price = prices[priceKey(token.chainId, token.tokenAddress)];
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      unpriced.push({
        symbol: token.symbol,
        chainId: token.chainId,
        balance,
        decimals: token.decimals,
      });
      continue;
    }

    total += toNumber(balance, token.decimals) * price;
    priced++;
  }

  return {
    total,
    priced,
    unpriced,
    isPartial: unpriced.length > 0,
  };
}

/**
 * Формат итога для показа с «≈».
 *
 * Крупные суммы без копеек: «≈ 1 234 $», мелкие — с двумя знаками. Точность
 * до цента у приблизительной цифры создавала бы ложное впечатление.
 */
export function formatTotal(total: number, currency = '$'): string {
  if (!Number.isFinite(total)) return `≈ ${currency}0`;
  const rounded = total >= 100 ? Math.round(total) : Math.round(total * 100) / 100;
  const text = rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: total >= 100 ? 0 : 2,
  });
  return `≈ ${currency}${text}`;
}
