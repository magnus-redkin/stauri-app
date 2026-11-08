/**
 * Состояние обмена токенов.
 *
 * ## Почему только mainnet
 *
 * У провайдеров (Paraswap, LI.FI) нет ликвидности в тестовых сетях, поэтому
 * обмен там невозможен в принципе. Это проверяется и в Rust (`swap.rs`), но и
 * на форме: иначе человек выбирал бы токены и получал отказ после нажатия.
 *
 * ## Почему оценка до пароля
 *
 * `get_swap_quote` только строит маршрут у провайдера и читает из него суммы.
 * Ключ не используется, подписи нет, в сеть ничего не уходит. Поэтому
 * «сколько получим» видно раньше, чем человек введёт пароль.
 *
 * ## Проскальзывание
 *
 * Допуск фиксированный (1 %) и показан на экране. Менять его в интерфейсе
 * пока не даём: это настройка для тех, кто понимает, что делает, а
 * необдуманно выставленные 10 % — прямой способ потерять деньги.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { walletState, type WalletToken } from './walletStore.svelte';
import { sendState } from './sendStore.svelte';
import { checkAmountAgainstBalance } from '$lib/utils/tokens';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type SwapStep = 'form' | 'confirm' | 'sending' | 'done' | 'failed';

/** Сети, где обмен работает. Совпадает с `SWAP_CHAINS` в `swap.rs`. */
export const SWAP_CHAINS: ReadonlySet<number> = new Set([1, 10, 56, 8453, 42161]);

/** Нативный актив: у него нулевой адрес. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** Допуск проскальзывания, зашитый в `swap.rs`. Показывается человеку. */
export const SLIPPAGE_PERCENT = 1;

export const swapState = $state({
  step: 'form' as SwapStep,
  /** Ключ исходного токена: `chainId:адрес`. */
  fromKey: '',
  /** Ключ целевого токена. */
  toKey: '',
  /** Сумма к обмену, как ввёл человек. */
  amount: '',
  /** Сколько получим (минимальные единицы целевого токена). */
  amountOut: null as bigint | null,
  /** Минимум при текущем проскальзывании. */
  minAmountOut: null as bigint | null,
  /** Комиссия сети в wei. `null` — не посчитана. */
  fee: null as bigint | null,
  /** Нужен ли отдельный approve. */
  needsApproval: false,
  /** Через кого идёт обмен. */
  provider: '',
  isQuoting: false,
  quoteError: '',
  isSending: false,
  error: '',
  txHash: '',
  approvalTxHash: '',
  /** Обмен в тестовой сети невозможен. */
  unsupportedChain: false,
});

export function resetSwap(): void {
  swapState.step = 'form';
  swapState.fromKey = '';
  swapState.toKey = '';
  swapState.amount = '';
  swapState.amountOut = null;
  swapState.minAmountOut = null;
  swapState.fee = null;
  swapState.needsApproval = false;
  swapState.provider = '';
  swapState.isQuoting = false;
  swapState.quoteError = '';
  swapState.isSending = false;
  swapState.error = '';
  swapState.txHash = '';
  swapState.approvalTxHash = '';
  swapState.unsupportedChain = false;
}

/** Ключ токена в том же виде, что и в `walletStore`. */
export function tokenKeyOf(token: WalletToken): string {
  return `${token.chainId}:${token.tokenAddress.toLowerCase()}`;
}

/** Токены, которые можно отдать: с ненулевым балансом в основной сети. */
export function swapSources(tokens: WalletToken[]): WalletToken[] {
  return tokens.filter(
    (t) => SWAP_CHAINS.has(t.chainId) && !t.hasError && t.balance !== '0'
  );
}

/**
 * Токены, которые можно получить: та же сеть, что у источника.
 *
 * Список ограничен известными кошельку токенами этой сети, включая нулевые:
 * держать в интерфейсе 17 700 токенов бессмысленно. Прочие адреса человек
 * может ввести вручную — поле рядом.
 */
export function swapTargets(tokens: WalletToken[], chainId: number | null): WalletToken[] {
  if (chainId === null) return [];
  return tokens.filter((t) => t.chainId === chainId);
}

/** Ищет токен по ключу. */
export function findToken(tokens: WalletToken[], key: string): WalletToken | undefined {
  return tokens.find((t) => tokenKeyOf(t) === key);
}

/**
 * Запрашивает оценку обмена.
 *
 * Вызывается при входе на подтверждение и при смене суммы. Ошибка не
 * блокирует экран совсем, но кнопку отправки выключает: без суммы на выходе
 * человек не знает, на что соглашается.
 */
export async function quoteSwap(
  fromToken: WalletToken,
  toToken: WalletToken,
  amountRaw: string
): Promise<void> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) return;

  // `checkAmountAgainstBalance` возвращает код ошибки, а не бросает: разбор
  // суммы и сравнение с балансом нужны оба, и оба дают переводимый код.
  const parsed = checkAmountAgainstBalance(amountRaw, fromToken);
  if (!parsed.ok) {
    swapState.quoteError = parsed.error;
    swapState.amountOut = null;
    return;
  }

  swapState.isQuoting = true;
  swapState.quoteError = '';
  swapState.amountOut = null;
  swapState.minAmountOut = null;

  try {
    const quote = await invoke<{
      amount_out: string;
      min_amount_out: string;
      fee: string | null;
      needs_approval: boolean;
      provider: string;
    }>('get_swap_quote', {
      // Имена — camelCase: Tauri сам приводит аргументы команды к этому виду.
      port,
      chainId: fromToken.chainId,
      from: walletState.address,
      fromToken: fromToken.tokenAddress,
      toToken: toToken.tokenAddress,
      amount: parsed.amount.toString(),
    });

    swapState.amountOut = BigInt(quote.amount_out);
    swapState.minAmountOut = BigInt(quote.min_amount_out);
    swapState.fee = quote.fee === null ? null : BigInt(quote.fee);
    swapState.needsApproval = quote.needs_approval;
    swapState.provider = quote.provider;
    debug(
      `[swap] quote: ${quote.amount_out} out, min ${quote.min_amount_out}, via ${quote.provider}`
    );
  } catch (e) {
    swapState.quoteError = formatError(e, 'Failed to get a swap quote');
    debug('[swap] quote failed:', e);
  } finally {
    swapState.isQuoting = false;
  }
}

/**
 * Выполняет обмен.
 *
 * Пароль берётся из общей сессии, как в переводе и регистрации имени: он уже
 * нужен для любой подписи, и спрашивать его ещё раз в третьем месте — лишний
 * ввод.
 */
export async function performSwap(
  fromToken: WalletToken,
  toToken: WalletToken,
  amountRaw: string
): Promise<boolean> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) {
    swapState.error = 'Wallet is not ready';
    swapState.step = 'failed';
    return false;
  }

  const parsed = checkAmountAgainstBalance(amountRaw, fromToken);
  if (!parsed.ok) {
    swapState.error = parsed.error;
    swapState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    return false;
  }

  swapState.isSending = true;
  swapState.step = 'sending';
  swapState.error = '';

  try {
    const result = await invoke<{ tx_hash: string; approval_tx_hash: string }>('swap_tokens', {
      request: {
        // Внутри `request` — snake_case: это serde-структура `SwapRequest`.
        port,
        chain_id: fromToken.chainId,
        from: walletState.address,
        from_token: fromToken.tokenAddress,
        to_token: toToken.tokenAddress,
        amount: parsed.amount.toString(),
        password: sendState.password,
      },
    });

    swapState.txHash = result?.tx_hash ?? '';
    swapState.approvalTxHash = result?.approval_tx_hash ?? '';
    swapState.step = 'done';
    info(`[swap] executed ${result?.tx_hash}`);
    return true;
  } catch (e) {
    const message = formatError(e, 'Failed to swap');
    if (/incorrect password|decrypt|authentication/i.test(message)) {
      sendState.password = '';
      sendState.needsPassword = true;
    }
    swapState.error = message;
    swapState.step = 'failed';
    warn('[swap] failed:', e);
    return false;
  } finally {
    swapState.isSending = false;
  }
}

/** Вернуться на форму. */
export function backToSwapForm(): void {
  swapState.step = 'form';
  swapState.error = '';
  swapState.txHash = '';
}

/** Меняет местами исходный и целевой токен. */
export function flipTokens(): void {
  const from = swapState.fromKey;
  swapState.fromKey = swapState.toKey;
  swapState.toKey = from;
  swapState.amountOut = null;
  swapState.minAmountOut = null;
}
