/**
 * Жизненный цикл соединения с бэкендом: запуск ноды, вход, создание аккаунта.
 *
 * Разбито на модули (шаг 12 плана):
 *   - `rpcConfig.ts` — `configureWalletRpc`, настройка RPC-провайдеров;
 *   - `ws.ts`        — WebSocket к `/signals`;
 *   - этот файл       — состояние соединения и сценарии входа.
 *
 * Публичный API сохранён: внешний код по-прежнему импортирует всё
 * из `connectionStore.svelte` (см. реэкспорт в конце файла).
 */

import {
  statusState,
  setAccounts,
  setNetworkInfo,
  waitForLogin,
  waitForNodeStopped,
} from './statusStore.svelte';
import { invoke } from '@tauri-apps/api/core';
import { debug } from '$lib/utils/log';
import { formatError, errorTag } from '$lib/utils/errors';
import {
  startBackend,
  stopBackend,
  initializeApplication,
  loginAccount,
  createAccountAndLogin,
  startMessenger,
  logout as apiLogout,
} from '$lib/status/api';
import { ensureTestNetworkMode, getSettings } from '$lib/status/wallet';
import { configureWalletRpc } from './rpcConfig';
import { isWsOpen, openWs, closeWs } from './ws';

export const connectionState = $state({
  isConnecting: false,
  selectedNetwork: 'mainnet',
});

/**
 * Запускает бэкенд, подключает WS и загружает аккаунты.
 */
export async function connect(network?: string) {
  if (statusState.isConnected || connectionState.isConnecting) return;

  if (statusState.backendPort) {
    await disconnect();
  }

  connectionState.isConnecting = true;
  statusState.errorMsg = '';

  try {
    const backendInfo = await startBackend(network);
    // Порт АУТЕНТИФИЦИРУЮЩЕГО ПРОКСИ, а не бэкенда: прокси проверяет
    // токен и только потом пересылает запрос настоящему бэкенду.
    statusState.backendPort = backendInfo.authPort;
    statusState.backendDataDir = backendInfo.dataDir;
    connectionState.selectedNetwork = backendInfo.networkName;

    await new Promise(resolve => setTimeout(resolve, 1500));

    const initData = await initializeApplication(
      statusState.backendPort,
      statusState.backendDataDir,
      backendInfo.chainId
    );

    if (initData.accounts && initData.accounts.length > 0) {
      setAccounts(initData.accounts);
    } else {
      setAccounts([]);
    }

    setNetworkInfo(
      backendInfo.networkName,
      backendInfo.rpcUrl,
      backendInfo.wakuFleet,
      backendInfo.isTestnet,
      backendInfo.chainId
    );

    await openWs(statusState.backendPort);
    statusState.isConnected = true;

    // Провайдеры прописываем сразу после инициализации — ДО логина.
    // RPC-клиенты status-go кэшируются по chainID и не инвалидируются,
    // поэтому если клиент создан раньше (например, messenger'ом или
    // фоновым refresher'ом), смена провайдера уже не подействует.
    //
    // Режим тестовых сетей здесь выставить НЕЛЬЗЯ: `settings_*`
    // регистрируется в initServices, то есть после старта ноды, а нода
    // стартует внутри LoginAccount. Переключение режима сделано в `login()`
    // и `createAccount()` — см. `applyNetworkMode`.
    await configureWalletRpc(backendInfo.authPort);

    // FIX: Блок preferences_set удалён отсюда.
    // Сети регистрируются в processSignal ПОСЛЕ node.login через
    // ensureNetworksConfigured, иначе LoginAccount перезатирает настройки.

  } catch (e: any) {
    statusState.errorMsg = `${errorTag(e)}Connection failed: ${formatError(e)}`;
    statusState.isConnected = false;
  } finally {
    connectionState.isConnecting = false;
  }
}

/**
 * Перезапускает бэкенд для новой сети.
 */
export async function changeNetwork(network: string) {
  await disconnect();
  await connect(network);
}

/**
 * Перезапускает ноду один раз, чтобы RPC-клиенты собрались заново.
 *
 * Зачем. status-go создаёт и кэширует RPC-клиента при первом обращении к сети
 * (internal/rpc/client.go, getClientUsingCache) и не инвалидирует кэш до
 * StatusNode.Stop(). Нода стартует внутри loginAccount, а её кошелёк сразу
 * запускает фоновый опрос балансов — то есть клиент успевает собраться раньше,
 * чем мы запишем провайдеров. На чистом профиле (первый вход) это значит, что
 * клиент собран из встроенных провайдеров, и до перезапуска балансы будут с
 * ошибкой.
 *
 * Порядок: выход → дождаться node.stopped → вход → провайдеры → messenger.
 * Провайдеры к этому моменту уже лежат в БД, а InitEmbeddedNetworks сохраняет
 * user-провайдеров при старте (pkg/services/networks/network.go), поэтому
 * новый клиент собирается уже с ними.
 *
 * Перезапуск делается один раз: повторный его результат не изменит, а цикл
 * входа мы себе позволить не можем.
 */
async function restartNodeForProviders(password: string, keyUid: string): Promise<boolean> {
  const port = statusState.backendPort;
  if (!port || !keyUid) return false;

  debug('[login] провайдеры записаны после старта ноды — перезапускаю ноду');

  // Ждать начинаем ДО logout: сигнал node.stopped может прийти раньше, чем
  // управление вернётся из вызова, и тогда ожидание продлилось бы все 15 с.
  // Нода останавливается асинхронно; вход до её остановки вернёт тот же
  // закэшированный клиент.
  const stopped = waitForNodeStopped(15000);
  await apiLogout(port);
  await stopped;

  // Ошибку входа не глотаем: если нода не поднялась, продолжать не с чем —
  // пусть вызывающий код покажет её пользователю.
  await traceSecret('login', password);
  await loginAccount(port, password, keyUid);
  await waitForLoginReady(port, 30000);

  await configureWalletRpc(port);
  await startMessenger(port);
  return true;
}

/**
 * Приводит режим сетей (mainnet / testnet) к тому, который задан запуском.
 *
 * ## Зачем это нужно
 *
 * `STAURI_NETWORK` — конфиг Rust: какая сеть основная, какой waku-fleet и
 * какой каталог данных. Самому status-go он ничего не говорит: там есть
 * отдельный флаг `test-networks-enabled?`, и `networks.GetActiveNetworks()`
 * фильтрует сети по нему. Пока флаг не выставлен, профиль, запущенный как
 * «sepolia», считает балансы по mainnet-сетям (1, 10, 56, 8453, 42161) —
 * и пользователь видит нули вместо сеполовских активов.
 *
 * ## Почему здесь, а не в `connect()`
 *
 * `settings_*` регистрируется в `initServices`, то есть после старта ноды, а
 * нода стартует внутри `loginAccount`. До входа вызов отвечает «method not
 * found» — ровно как `networks_*`.
 *
 * ## Что возвращаем
 *
 * `true`, если флаг пришлось переписать. Смена режима меняет набор активных
 * сетей, а RPC-клиенты бэкенда кэшированы по chainID (см.
 * `restartNodeForProviders`), поэтому вызывающий код должен перезапустить
 * ноду — иначе балансы придут по прежним сетям.
 */
async function applyNetworkMode(port: number): Promise<boolean> {
  try {
    const changed = await ensureTestNetworkMode(port, statusState.isTestnet);
    if (changed) {
      debug(
        `[connect] test networks mode switched to ${statusState.isTestnet ? 'on' : 'off'}`
      );
    }
    return changed;
  } catch (e) {
    // Не валим вход: кошелёк покажет то, что считает бэкенд, и это видно
    // на экране «Активы». Сообщение объясняет, почему числа не те.
    statusState.errorMsg = `Failed to set network mode: ${formatError(e)}`;
    console.error('[connect] ensureTestNetworkMode failed:', e);
    return false;
  }
}

/**
 * Вход в аккаунт.
 *
 * Порядок важен: сначала прописываем RPC-провайдеры (configureWalletRpc),
 * и только потом стартуем messenger. RPC-клиенты status-go кэшируются по
 * chainID и не инвалидируются, поэтому messenger, запущенный раньше, создаст
 * клиентов с прежними (мёртвыми) URL, и балансы останутся с hasError.
 *
 * Если провайдеров пришлось дописывать, значит клиент мог быть собран раньше
 * них (типичный случай — первый вход на чистом профиле): ноду перезапускаем
 * один раз, см. restartNodeForProviders.
 */
export async function login(password: string, keyUid: string) {
  if (!statusState.backendPort) return;
  const port = statusState.backendPort;
  if (!isWsOpen()) await openWs(port);

  await traceSecret('login', password);
  await loginAccount(port, password, keyUid);
  await waitForLoginReady(port, 30000);

  // Режим сетей — до провайдеров: он определяет, для каких сетей их писать.
  const modeChanged = await applyNetworkMode(port);

  const { wroteProviders } = await configureWalletRpc(port);
  if ((modeChanged || wroteProviders) && (await restartNodeForProviders(password, keyUid))) return;

  await startMessenger(port);
}

/**
 * Создание аккаунта.
 *
 * Это заведомо чистый профиль: провайдеров в БД ещё нет, поэтому
 * configureWalletRpc наверняка что-то запишет, а RPC-клиенты к тому моменту
 * уже собраны из встроенных. Перезапуск ноды здесь не исключение, а норма —
 * см. restartNodeForProviders.
 */
export async function createAccount(password: string) {
  if (!statusState.backendPort) return;
  const port = statusState.backendPort;
  if (!isWsOpen()) await openWs(port);
  await traceSecret('create', password);
  const createResult = await createAccountAndLogin(port, statusState.backendDataDir, password);
  if (createResult?.error) throw new Error(createResult.error);
  if (isAndroidRuntime()) {
    // Android: сигнала node.login нет (колбэк SetSignalEventCallback не подключён),
    // поэтому ждём, пока нода сама ответит на settings_getSettings.
    await waitForNodeLogin(port, 30000);
  } else {
    await waitForLogin(30000);
  }

  const keyUid = statusState.accountKeyUid;
  const modeChanged = await applyNetworkMode(port);
  const { wroteProviders } = await configureWalletRpc(port);
  if ((modeChanged || wroteProviders) && (await restartNodeForProviders(password, keyUid))) return;

  await startMessenger(port);
}

/** Ожидание входа: на десктопе по сигналу node.login, на Android — опросом ноды. */
async function waitForLoginReady(port: number, timeoutMs: number): Promise<void> {
  if (isAndroidRuntime()) return waitForNodeLogin(port, timeoutMs);
  return waitForLogin(timeoutMs);
}

/** Тестовая трасса: одна строка в bridge-trace.log через status_call. */
async function traceNote(note: unknown): Promise<void> {
  try {
    await invoke('status_call', { endpoint: 'TraceNote', body: JSON.stringify(note) });
  } catch {
    /* трасса не должна ломать вход */
  }
}

/**
 * Тестовая трасса: длина пароля и SHA-256-префикс в bridge-trace.log.
 * Сам пароль никуда не пишется.
 */
async function traceSecret(kind: string, password: string): Promise<void> {
  if (!isAndroidRuntime()) return;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    await traceNote({ kind, len: password.length, sha256_16: hex.slice(0, 16) });
  } catch {
    /* трасса не должна ломать вход */
  }
}

/** Android: сигналов из libstatus.so пока нет, проверяем вход опросом ноды. */
function isAndroidRuntime(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/**
 * Ждёт, пока нода вошла в аккаунт: settings_getSettings вернёт key-uid.
 * Выставляет isLoggedIn и accountKeyUid, как это делает сигнал node.login.
 */
async function waitForNodeLogin(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const raw = await getSettings(port);
      // CallRPC отдаёт конверт JSON-RPC: настройки лежат в result.
      const settings = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw;
      const keyUid = settings?.['key-uid'];
      if (attempt <= 5 && isAndroidRuntime()) {
        await traceNote({
   attempt,
   keys: settings && typeof settings === 'object' ? Object.keys(settings) : typeof settings,
          keyUid: typeof keyUid === 'string' ? keyUid.slice(0, 10) : keyUid ?? null,
   raw: JSON.stringify(settings ?? null).slice(0, 300),
        });
      }
      if (typeof keyUid === 'string' && keyUid.length > 0) {
               statusState.accountKeyUid = keyUid;
 // Те же поля, что приходят в сигнале node.login: без сигнала на Android
        // публичный ключ и alias иначе не появятся в профиле и в инвайте.
        if (typeof settings['public-key'] === 'string' && settings['public-key']) {
   statusState.publicKey = settings['public-key'];
        }
        if (typeof settings['compressedKey'] === 'string' && settings['compressedKey']) {
   statusState.compressedKey = settings['compressedKey'];
        }
        if (typeof settings['alias'] === 'string' && settings['alias']) {
          statusState.alias = settings['alias'];
        }
        statusState.isLoggedIn = true;
 return;
      }
      lastError = 'settings without key-uid';
    } catch (e) {
      lastError = String(e);
      if (attempt <= 5 && isAndroidRuntime()) await traceNote({ attempt, error: lastError.slice(0, 300) });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Login timeout: node did not answer (${lastError})`);
}

/**
 * Отключает WS и останавливает бэкенд.
 */
export async function disconnect() {
  await closeWs();
  if (statusState.backendPort) {
    try { await stopBackend(); } catch {
      /* закрытие сокета не критично: следующий connect создаст новый */
    }
  }
  await new Promise(r => setTimeout(r, 500));
  statusState.isConnected = false;
  statusState.backendPort = null;
}
