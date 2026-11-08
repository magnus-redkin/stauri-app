/**
 * Состояние регистрации имени ENS (`<имя>.stateofus.eth`).
 *
 * ## Где живёт пароль
 *
 * Тот же принцип, что в `sendStore`: пароль берётся из общей сессии
 * (`sendState.password`), а не спрашивается отдельно и не хранится здесь.
 * Регистрация — тоже транзакция, и второй запрос пароля на пустом месте был
 * бы просто лишним вводом.
 *
 * ## Почему вся последовательность — в Rust
 *
 * Регистрация подписывает столько транзакций, сколько вернул Router, а
 * `wallet_signMessage` подписывает любые 32 байта. Если бы хэши приходили в
 * webview, чужой скрипт мог бы попросить подписать любой из них. Команда
 * `register_ens_name` держит и хэши, и пароль, и разбор подписи внутри себя;
 * наружу уходит только «зарегистрируй такое-то имя». См. `src-tauri/src/ens.rs`.
 *
 * ## Почему имя вводится без домена
 *
 * `.stateofus.eth` — единственный домен, который умеет регистратор Status
 * (`UsernameToLabel` хэширует именно этот label). Писать его в поле рядом с
 * именем значило бы позволять ввести `.eth` и получить `.eth.stateofus.eth`.
 * Поэтому поле — только имя, домен дописывается сам и показан рядом.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { walletState, loadWallet } from './walletStore.svelte';
import { sendState } from './sendStore.svelte';
import { addEnsUsername, getEnsUsernames } from '$lib/status/wallet';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type EnsStep = 'form' | 'confirm' | 'sending' | 'done' | 'failed';

/** Домен, под которым регистратор Status выдаёт имена. */
export const ENS_DOMAIN = 'stateofus.eth';

export const ensState = $state({
  step: 'form' as EnsStep,
  /** Имя без домена, как ввёл человек. */
  username: '',
  /** Цена в минимальных единицах SNT/STT (строкой: 18 знаков). */
  price: null as bigint | null,
  /** Комиссия сети в wei. */
  fee: null as bigint | null,
  /** Имя занято кем-то другим. */
  taken: false,
  /** Владелец, если имя занято. */
  owner: '',
  isChecking: false,
  /** Почему не удалось проверить цену/занятость. */
  checkError: '',
  isSending: false,
  error: '',
  txHash: '',
  /** Полное имя после успешной регистрации. */
  fullName: '',
  /** Сети, где регистрация невозможна (не mainnet и не Sepolia). */
  unsupportedChain: false,
  /**
   * Имена этого профиля, записанные в его базу (`ens_getEnsUsernames`).
   *
   * Отдельно от `fullName`: `fullName` — результат последней регистрации в
   * этой сессии, а здесь — то, что профиль знает о себе постоянно. Именно
   * это показывается под именем в профиле.
   */
  profileNames: [] as string[],
});

export function resetEns(): void {
  ensState.step = 'form';
  ensState.username = '';
  ensState.price = null;
  ensState.fee = null;
  ensState.taken = false;
  ensState.owner = '';
  ensState.isChecking = false;
  ensState.checkError = '';
  ensState.isSending = false;
  ensState.error = '';
  ensState.txHash = '';
  ensState.fullName = '';
  ensState.unsupportedChain = false;
  ensState.profileNames = [];
}

/** Сети, где у Status есть регистратор (совпадает с `snt_address` в Rust). */
export function ensSupported(chainId: number): boolean {
  return chainId === 1 || chainId === 11155111;
}

/**
 * Правила имени — те же, что в Rust (`validate_username`).
 *
 * Дублирование осознанное: здесь оно нужно, чтобы не отправлять заведомо
 * неверный запрос и сразу подсказать, что не так. Решает всё равно Rust —
 * эта проверка только для подсказки на форме.
 */
export function usernameError(name: string): string {
  const value = name.trim();
  if (!value) return 'ens-name-empty';
  if (value.length < 3 || value.length > 31) return 'ens-name-length';
  if (value.startsWith('-') || value.endsWith('-')) return 'ens-name-hyphen';
  if (!/^[a-z0-9-]+$/.test(value)) return 'ens-name-chars';
  return '';
}

/**
 * Адрес залогового токена по сети.
 *
 * Обязан совпадать с `snt_address` в `src-tauri/src/ens.rs`, иначе баланс
 * не найдётся и человек увидит «нет средств» при полном кошельке. Один и
 * тот же контракт называется SNT на mainnet и STT на Sepolia — поэтому
 * ищем по адресу, а не по символу.
 */
const STAKE_ADDRESS: Record<number, string> = {
  1: '0x744d70fdbe2ba4cf95131626614a1763df805b9e',
  11155111: '0xe452027cdef746c7cd3db31cb700428b16cd8e51',
};

/** Нативный актив в ответе бэкенда — нулевой адрес. */
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ChainBalances {
  /** Залоговый токен (SNT/STT). `null` — не загружен или RPC не ответил. */
  stake: bigint | null;
  /** Нативный ETH этой сети: им платится комиссия. */
  native: bigint | null;
}

/**
 * Балансы, которые решают, пройдёт ли регистрация.
 *
 * `null` вместо нуля там, где баланс неизвестен: токен мог не прийти в
 * ответе или прийти с `hasError`. Показывать «0» в этом случае значило бы
 * утверждать, что денег нет, хотя их просто не спросили.
 */
export function chainBalances(chainId: number): ChainBalances {
  const find = (address: string): bigint | null => {
    const token = walletState.balances.find(
      (t) =>
        t.chainId === chainId &&
        t.tokenAddress.toLowerCase() === address.toLowerCase()
    );
    if (!token || token.hasError) return null;
    try {
      return BigInt(token.balance || '0');
    } catch {
      return null;
    }
  };

  const stakeAddress = STAKE_ADDRESS[chainId];
  return {
    stake: stakeAddress ? find(stakeAddress) : null,
    native: find(NATIVE_ADDRESS),
  };
}

/**
 * Адрес кошелька для подписи и адресата.
 *
 * ## Почему не просто `walletState.address`
 *
 * Пока ENS жил вкладкой кошелька, адрес уже был загружен: `walletStore` читает
 * его при входе в раздел. Теперь блок стоит в профиле, куда человек может
 * прийти первым делом, ни разу не открыв кошелёк, — и `walletState.address`
 * там пуст. Без этого `checkName` молча выходил бы, а поле выглядело бы
 * нерабочим (ровно та жалоба, из-за которой вкладка и переехала).
 *
 * `loadWallet()` идемпотентен: если данные уже есть, он только перечитает
 * их при `force`, а при загруженном состоянии сразу вернётся.
 */
async function ensureWalletAddress(): Promise<string> {
  if (walletState.address) return walletState.address;
  try {
    await loadWallet();
  } catch (e) {
    debug('[ens] wallet address load failed:', e);
  }
  return walletState.address;
}

/** Цена и занятость имени. Только чтение: пароль не нужен. */
export async function checkName(): Promise<void> {
  const port = statusState.backendPort;
  if (!port) return;

  const chainId = statusState.chainId;
  ensState.unsupportedChain = !ensSupported(chainId);
  if (ensState.unsupportedChain) return;

  const name = ensState.username.trim();
  if (usernameError(name)) return;

  const address = await ensureWalletAddress();
  if (!address) {
    ensState.checkError = 'Wallet is not ready';
    return;
  }

  ensState.isChecking = true;
  ensState.checkError = '';
  ensState.taken = false;
  ensState.owner = '';

  try {
    const quote = await invoke<{
      price: string;
      /** `null` — комиссию получить не удалось (не ноль!). */
      fee: string | null;
      expires_at: string;
      owner: string;
      available: boolean;
    }>('get_ens_quote', {
      port,
      // Имя аргумента — `chainId`, а не `chain_id`: Tauri сам приводит
      // параметры команды к camelCase, и на `chain_id` отвечает
      // «missing required key chainId». В Rust параметр остаётся `chain_id`.
      chainId,
      from: walletState.address,
      username: name,
    });

    ensState.price = BigInt(quote.price);
    // `null` остаётся `null`: иначе интерфейс показал бы «0», то есть
    // «перевод бесплатный», хотя комиссия просто неизвестна.
    ensState.fee = quote.fee === null ? null : BigInt(quote.fee);
    ensState.taken = !quote.available;
    ensState.owner = quote.owner;
    debug(
      `[ens] quote for ${name}: price ${quote.price}, fee ${quote.fee}, available ${quote.available}`
    );
  } catch (e) {
    // Не блокируем: цену можно перепроверить на подтверждении, а решение
    // всё равно за контрактом.
    ensState.price = null;
    ensState.fee = null;
    ensState.checkError = formatError(e, 'Failed to check the name');
    debug('[ens] quote failed:', e);
  } finally {
    ensState.isChecking = false;
  }
}

/** Перейти к экрану подтверждения, обновив цену. */
export async function goToConfirm(): Promise<void> {
  await checkName();
  ensState.error = '';
  ensState.step = 'confirm';
}

/**
 * Читает имена, записанные в профиль.
 *
 * ## Почему из профиля, а не с контракта
 *
 * Владельца имени знает блокчейн, но «какое из моих имён показывать рядом с
 * ником» — это свойство профиля, и живёт оно в его базе. Читаем
 * `ens_getEnsUsernames`, а не `ens_getName`: обратное разрешение (адрес →
 * имя) работает только при наличии reverse-записи, а регистратор Status её
 * не создаёт — проверено на живом бэкенде после регистрации `magnus-redkin`,
 * вернулось пусто.
 *
 * Ошибку не пробрасываем: имя в профиле — украшение, а не условие работы.
 */
export async function loadProfileNames(): Promise<void> {
  const port = statusState.backendPort;
  if (!port) return;

  try {
    const names = await getEnsUsernames(port);
    ensState.profileNames = names
      .filter((n: any) => n && n.username && n.removed !== true)
      .map((n: any) => String(n.username));
  } catch (e) {
    debug('[ens] failed to read profile names:', e);
  }
}

/**
 * Зарегистрировать имя.
 *
 * Пароль берётся из сессии (`sendState.password`). Если его нет — возвращаем
 * `false` и поднимаем флаг, чтобы экран показал поле ввода: ровно так же
 * поступает `sendTransfer`.
 */
export async function registerName(): Promise<boolean> {
  const port = statusState.backendPort;
  if (!port) {
    ensState.error = 'Wallet is not ready';
    ensState.step = 'failed';
    return false;
  }

  // Адрес мог не загрузиться, если человек пришёл в профиль, не открывая
  // кошелёк. Догружаем тем же способом, что и в `checkName`.
  const address = await ensureWalletAddress();
  if (!address) {
    ensState.error = 'Wallet is not ready';
    ensState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    return false;
  }

  ensState.isSending = true;
  ensState.step = 'sending';
  ensState.error = '';

  try {
    const result = await invoke<{ tx_hash: string; full_name: string }>('register_ens_name', {
      request: {
        // Внутри `request` имена остаются snake_case: это serde-структура
        // `EnsRegisterRequest`, а camelCase-преобразование Tauri касается
        // только верхнеуровневых аргументов команды (как `chainId` выше).
        port,
        chain_id: statusState.chainId,
        from: walletState.address,
        username: ensState.username.trim(),
        password: sendState.password,
      },
    });

    ensState.txHash = result?.tx_hash ?? '';
    ensState.fullName = result?.full_name ?? '';
    ensState.step = 'done';
    info(`[ens] registered ${ensState.fullName} in ${ensState.txHash}`);

    // Записываем имя в профиль. Транзакция в блокчейне профиль ни о чём не
    // извещает: `ens_getEnsUsernames` читает его собственную таблицу, и без
    // этой записи имя осталось бы видимым только на цепи.
    if (ensState.fullName) {
      try {
        await addEnsUsername(port, statusState.chainId, ensState.fullName);
        await loadProfileNames();
      } catch (e) {
        // Не валим регистрацию: имя уже в блокчейне, и повторять транзакцию
        // из-за несохранённой строки в профиле было бы дорого.
        warn('[ens] registered on chain but failed to record it in the profile:', e);
      }
    }

    return true;
  } catch (e) {
    const message = formatError(e, 'Failed to register the name');
    // Неверный пароль стираем, чтобы не повторять неудачу молча.
    if (/incorrect password|decrypt|authentication/i.test(message)) {
      sendState.password = '';
      sendState.needsPassword = true;
    }
    ensState.error = message;
    ensState.step = 'failed';
    warn('[ens] registration failed:', e);
    return false;
  } finally {
    ensState.isSending = false;
  }
}

/** Вернуться к форме. */
export function backToEnsForm(): void {
  ensState.step = 'form';
  ensState.error = '';
}
