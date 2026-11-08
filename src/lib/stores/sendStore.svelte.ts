/**
 * Состояние отправки средств.
 *
 * ## Где живёт пароль
 *
 * Пароль профиля нужен на каждом переводе: status-go разблокирует ключ им
 * (`wallet_signMessage` → `gethManager.LoadAccount`). Пользователь вводит его
 * **один раз за сессию**, как в мобильном Status, и дальше он хранится здесь,
 * в памяти фронтенда, до выхода из аккаунта.
 *
 * Это осознанный выбор с известной ценой: при XSS пароль доступен скрипту.
 * Поэтому сам перевод идёт через команду Rust `send_transfer` — пароль
 * передаётся в неё на время вызова, а подпись и сборка транзакции наружу не
 * выставлены. Так у чужого скрипта нет ни универсальной машинки подписи, ни
 * сохранённого пароля на диске.
 *
 * На диск пароль НЕ пишется никогда. `resetSend()` вызывается при выходе из
 * аккаунта.
 *
 * ## Почему шаги, а не одна форма
 *
 * Между «ввёл» и «улетело» нужен экран, где видно всё, что уйдёт: сеть,
 * актив, сумму, получателя и комиссию. Это последняя возможность заметить,
 * что адрес не тот. Кнопка «Отправить» на этом экране фиксирует намерение,
 * и только после неё начинается работа с ключом.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { loadWallet, walletState, type WalletToken } from './walletStore.svelte';
import { restartWalletReloadTimer } from '$lib/status/wallet';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type SendStep = 'form' | 'confirm' | 'sending' | 'sent' | 'failed';

/**
 * Причина отказа отправки.
 *
 * Каждая — отдельным кодом, потому что человеку нужно разное действие:
 * при неверном пароле — ввести заново, при нехватке средств — уменьшить
 * сумму, при недоступном RPC — подождать. Один текст «Failed» не говорит
 * ничего.
 */
export type SendErrorCode =
  | 'send-wallet-not-ready'
  | 'send-wrong-password'
  | 'send-insufficient-funds'
  | 'send-rpc-unavailable'
  | 'send-invalid-address'
  | 'send-unknown';

export const sendState = $state({
  step: 'form' as SendStep,
  /** Пароль сессии. В памяти, не на диске. */
  password: '',
  /** Пароль запрашивается у пользователя — показывается поле ввода. */
  needsPassword: false,
  isSending: false,
  error: '',
  /** Хэш отправленной транзакции — для ссылки в обозреватель. */
  txHash: '',
  /**
   * Оценка комиссии в минимальных единицах (null — ещё не посчитана).
   *
   * Считается на шаге подтверждения ДО ввода пароля: `estimate_transfer_fee`
   * только собирает транзакцию, ключ не трогает и в сеть не отправляет.
   */
  fee: null as bigint | null,
  /** Идёт оценка комиссии. */
  isEstimating: false,
  /** Комиссию получить не удалось — показываем причину, но не блокируем. */
  feeError: '',
  /**
   * Ошибка, разобранная по причине, для показа человеку.
   *
   * Код вместо текста: перевод ошибки status-go в понятную фразу — дело
   * интерфейса, и он должен быть переводимым.
   */
  errorCode: '' as SendErrorCode | '',
});

/** Забыть пароль. Вызывается при выходе из аккаунта и смене профиля. */
export function resetSend(): void {
  sendState.step = 'form';
  sendState.password = '';
  sendState.needsPassword = false;
  sendState.isSending = false;
  sendState.error = '';
  sendState.txHash = '';
  sendState.fee = null;
  sendState.isEstimating = false;
  sendState.feeError = '';
  sendState.errorCode = '';
}

/** Сохранить пароль в памяти сессии (после успешного ввода). */
export function rememberPassword(password: string): void {
  sendState.password = password;
  sendState.needsPassword = false;
}

export interface TransferInput {
  token: WalletToken;
  /** Адрес получателя, уже проверенный на форме. */
  to: string;
  /** Сумма в минимальных единицах. */
  amount: bigint;
}

/**
 * Оценка комиссии для перевода.
 *
 * Вызывается при входе на экран подтверждения, до ввода пароля: команда
 * только собирает транзакцию и читает из неё `gas` и `gasPrice`, ключ не
 * используется. Ошибка не блокирует отправку — если цену газа получить не
 * удалось, человек всё равно должен иметь возможность отправить, просто без
 * строки комиссии.
 */
export async function estimateFee(input: TransferInput): Promise<void> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) return;

  sendState.isEstimating = true;
  sendState.feeError = '';
  try {
    const result = await invoke<{ fee: string; gas: string; gas_price: string }>(
      'estimate_transfer_fee',
      {
        request: {
          port,
          chain_id: input.token.chainId,
          from: walletState.address,
          to: input.to,
          token_address: input.token.tokenAddress,
          amount: input.amount.toString(),
        },
      }
    );
    sendState.fee = BigInt(result.fee);
    debug(`[send] fee estimate: ${result.fee} wei (gas ${result.gas} × ${result.gas_price})`);
  } catch (e) {
    // Показываем причину рядом с местом комиссии, но не мешаем отправке:
    // сумму комиссии нода всё равно пересчитает при сборке.
    sendState.fee = null;
    sendState.feeError = formatError(e, 'Failed to estimate the fee');
    debug('[send] fee estimate failed:', e);
  } finally {
    sendState.isEstimating = false;
  }
}

/**
 * Относит ошибку status-go к одной из известных причин.
 *
 * status-go не даёт кодов — только текст, поэтому различаем по подстрокам.
 * Ошибиться не страшно: код влияет лишь на текст подсказки, отправку он не
 * меняет, а исходная ошибка остаётся в `error` и показывается целиком.
 */
export function classifySendError(message: string): SendErrorCode {
  const m = message.toLowerCase();

  if (m.includes('incorrect password') || m.includes('decrypt') || m.includes('authentication')) {
    return 'send-wrong-password';
  }
  if (m.includes('insufficient funds') || m.includes('exceeds balance') || m.includes('not enough')) {
    return 'send-insufficient-funds';
  }
  // RPC: сеть не ответила. Именно этот случай был у пользователя, когда
  // системный прокси рвал соединение, и все провайдеры отказали сразу.
  if (
    m.includes('error sending request') ||
    m.includes('bad gateway') ||
    m.includes('connection reset') ||
    m.includes('timeout') ||
    m.includes('502')
  ) {
    return 'send-rpc-unavailable';
  }
  if (m.includes('invalid') && m.includes('address')) {
    return 'send-invalid-address';
  }
  return 'send-unknown';
}

/**
 * Отправляет перевод.
 *
 * ## Почему вся последовательность — в Rust
 *
 * `send_transfer` делает три вызова status-go: собрать, подписать, отправить.
 * Если бы их делал фронтенд, вебвью пришлось бы вызывать `wallet_signMessage`
 * напрямую, а это универсальная подпись произвольных байтов ключом кошелька.
 * См. шапку `src-tauri/src/transfer.rs`.
 *
 * ## Почему баланс обновляем после отправки
 *
 * Кэш бэкенда обновляет фоновый контроллер, а не наш запрос
 * (`forceRefresh` в `wallet_fetchOrGetCachedWalletBalances` игнорируется).
 * Поэтому после отправки запускаем полный перезапрос и перечитываем.
 */
export async function sendTransfer(input: TransferInput): Promise<boolean> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) {
    sendState.error = 'Wallet is not ready';
    sendState.errorCode = 'send-wallet-not-ready';
    sendState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    sendState.error = '';
    return false;
  }

  sendState.isSending = true;
  sendState.step = 'sending';
  sendState.error = '';

  try {
    const result = await invoke<{ tx_hash: string }>('send_transfer', {
      request: {
        port,
        chain_id: input.token.chainId,
        from: walletState.address,
        to: input.to,
        token_address: input.token.tokenAddress,
        amount: input.amount.toString(),
        password: sendState.password,
      },
    });

    sendState.txHash = result?.tx_hash ?? '';
    sendState.step = 'sent';
    info(`[send] sent ${input.amount} of ${input.token.symbol} on ${input.token.chainId}`);

    // Баланс после перевода: перезапрос в фоне, затем чтение.
    void refreshAfterSend();
    return true;
  } catch (e) {
    // Неверный пароль — самый частый отказ. Стираем сохранённый, чтобы
    // следующий раз спросить заново, а не повторять неудачу молча.
    const message = formatError(e, 'Failed to send');
    sendState.errorCode = classifySendError(message);

    if (sendState.errorCode === 'send-wrong-password') {
      // Повторять заведомо неудачную попытку молча — худшее, что можно
      // сделать на этом экране: человек должен увидеть, что пароль не тот.
      sendState.password = '';
      sendState.needsPassword = true;
    }

    sendState.error = message;
    sendState.step = 'failed';
    warn('[send] failed:', e);
    return false;
  } finally {
    sendState.isSending = false;
  }
}

/** Обновление баланса после отправки. Ошибку не показываем: она вторична. */
async function refreshAfterSend(): Promise<void> {
  try {
    // Даём сети принять транзакцию, затем просим бэкенд перезапросить всё.
    await new Promise((r) => setTimeout(r, 3000));
    if (statusState.backendPort) {
      await restartWalletReloadTimer(statusState.backendPort);
      await new Promise((r) => setTimeout(r, 2000));
      await loadWallet(true);
    }
  } catch (e) {
    debug('[send] balance refresh after send failed:', e);
  }
}

/** Возвращает форму на шаг ввода — используется кнопкой «Изменить». */
export function backToForm(): void {
  sendState.step = 'form';
  sendState.error = '';
  sendState.txHash = '';
}
