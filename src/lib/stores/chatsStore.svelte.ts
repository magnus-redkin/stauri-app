import { statusState } from './statusStore.svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { debug, info, warn } from '$lib/utils/log';
import {
  getChats,
  getContacts,
  sendContactRequest,
  acceptContactRequest as acceptContactRequestRpc,
  declineContactRequest as declineContactRequestRpc,
  markChatRead,
  getCommunities,
  fetchCommunity,
  communityChannels,
  communityChatId,
  communityIdFromInvite,
  channelIdFromInvite,
  parseChannelInvite,
  checkPermissionsToJoinCommunity,
  generateJoiningRequestsForSigning,
  signJoinRequestData,
  requestToJoinCommunity,
  spectateCommunity,
  leaveCommunity,
  deactivateChat,
  isCommunityChat,
  isDirectMessage,
} from '$lib/status/messaging';
import {
  createChannel,
  validateChannelInput,
  type CreateChannelParams,
} from '$lib/status/akk';
import { getDisplayName } from '$lib/utils/user';
import { scenarioLog, short } from '$lib/utils/scenario';
import { parseKind } from '$lib/status/channelKind';
import { ROLE_OWNER } from '$lib/status/channelRights';
import { loadOpenedChannels, markChannelOpened } from '$lib/status/openedChannels';
import { feedChatItems } from './feedsStore.svelte';
import { formatError } from '$lib/utils/errors';
import type { ChatItem } from '$lib/sections/chat/ChatLeft.svelte';
import type { Community, CommunityChat } from '$lib/status/types';

export const chatsState = $state({
  items: [] as ChatItem[],
  contacts: [] as any[],
  communities: [] as Community[],
  selected: null as ChatItem | null,
  loaded: false,
  isLoading: false,
  /** Идёт вступление: блокирует повторные нажатия. */
  isJoining: false,
  /** Ошибка последнего вступления — показывается в диалоге. */
  joinError: '',
  /** Что показывает правая панель: переписка или один из экранов левой панели. */
  rightPanel: 'chat' as RightPanel,
});

/** Режимы правой панели раздела «Чат». */
export type RightPanel = 'chat' | 'contacts' | 'contactInvite' | 'joinInvite' | 'newChannel';

/**
 * Результат подключения к сообществу — для интерфейса.
 *
 * Четыре разных исхода, и пользователю важно понимать, какой именно:
 *   * `joined` — участник (бывает только после ответа владельца, сейчас не
 *     возвращается: заявка обрабатывается асинхронно);
 *   * `requested` — заявка отправлена и ждёт ответа;
 *   * `spectated` — сообщество открыто для просмотра, вступления не было;
 *   * `failed` — причина в `error`.
 */
export type JoinResult =
  | { status: 'joined'; name: string }
  | { status: 'requested'; name: string }
  | { status: 'spectated'; name: string }
  | { status: 'contact'; name: string }
  | { status: 'failed'; error: string };

/**
 * Строит список чатов для левой панели.
 *
 * ## Что попадает в список
 *
 * Только то, что пользователь сознательно держит под рукой:
 *   * личные чаты (1-1) — всегда;
 *   * каналы сообществ — только активные в status-go (`active`). Вступление
 *     делает канал активным, удаление из списка — `deactivateChat`.
 *
 * ## Почему каналы сообществ больше не добавляются целиком
 *
 * `spectateCommunity` создаёт `Chat`-записи для ВСЕХ каналов сообщества —
 * так задумано в status-go, чтобы сообщения читались и фильтры стояли.
 * Раньше мы брали их из `Community.chats` и выкладывали в список, и панель
 * превращалась в список сообществ: десять каналов одного сообщества
 * вытесняли личную переписку. Пользователь просил обратного — в левой
 * панели чаты 1-1 и каналы, добавленные из каталога в разделе dApp.
 *
 * Сами `Chat`-записи при этом никуда не деваются: сообщения читаются,
 * канал открывается из каталога. Изменился только список.
 */

function buildItems(
  previews: any[],
  contacts: any[],
  communities: Community[]
): ChatItem[] {
  const nameFor = (chat: any) => {
    const contact = contacts.find((ct: any) => ct.id === chat.id);
    return contact ? getDisplayName(contact) : getDisplayName(chat);
  };

  // Чат с самим собой. status-go создаёт его, если заявку отправили на
  // собственный ключ (ошибка ввода или чужой Invite с нашим профилем).
  // В списке он бесполезен и выглядит как контакт без имени: `0x0498b7…`.
  const ownKey = statusState.publicKey;

  // Метаданные каналов сообществ (имя, категория, право писать) — из сообществ.
  // Сам состав списка — из превью: канал в списке, только если status-go
  // считает его активным. Так удаление (`deactivateChat`) убирает канал сразу
  // и не даёт ему вернуться при следующей загрузке.
  const channelMeta = new SvelteMap<string, CommunityChat & { owned: boolean }>();
  for (const channel of communityChannels(communities)) {
    const community = communities.find((c) => c.id === channel.communityId);
    channelMeta.set(channel.id, { ...channel, owned: community?.memberRole === ROLE_OWNER });
  }

  const items: ChatItem[] = [];
  const openedChannels = loadOpenedChannels();
  // «По дате»: время последнего сообщения, иначе время самого чата (мс).
  function activityTs(chat: any): number {
    return Number(chat.lastMessage?.timestamp ?? chat.timestamp ?? 0) * 1000;
  }
  for (const chat of previews) {
    if (ownKey && String(chat.id).toLowerCase() === ownKey.toLowerCase()) continue;
    // Неактивный чат — значит удалён (`deactivateChat`), и он не должен
    // возвращаться в список. Исключение — входящий запрос в контакты: он тоже
    // приходит как неактивный, но его надо показать, чтобы принять.
    const pendingContactRequest = chat.lastMessage?.contactRequestState === 1;
    if (chat.active === false && !pendingContactRequest) {
      // Неактивный чат без запроса — удалённый; логируем, чтобы видеть, что скрыто.
      if (!isCommunityChat(chat) && !isDirectMessage(chat)) continue;
      scenarioLog('reply-sync', 'hidden-inactive', { chat: short(chat.id), type: chat.chatType }, 'info');
      continue;
    }
    if (pendingContactRequest) {
      scenarioLog('reply-sync', 'incoming-request', { chat: short(chat.id), type: chat.chatType }, 'info');
    }

    if (isCommunityChat(chat)) {
      const meta = channelMeta.get(chat.id);
      // Чужой канал показываем только если его открывали по ссылке. Спектация
      // создаёт все каналы чужого сообщества активными, и без этого в списке
      // оказались бы все они.
      if (!meta?.owned && !openedChannels.has(chat.id)) continue;
      items.push({
        id: chat.id,
        // Свой АКК-канал (владелец сообщества): имя сообщества и есть имя канала,
        // служебный `general` скрыт. Чужой канал: своё имя канала, а название
 // сообщества — в подписи, иначе все строки сообщества выглядели бы одинаково.
        name: meta?.owned
          ? meta?.communityName || chat.name
   : `${chat.name} · ${meta?.communityName ?? ''}`.replace(/ · $/, ''),
        lastMessage: chat.lastMessage?.text || '',
        sortTs: activityTs(chat),
 type: 'community',
        communityId: chat.communityId || meta?.communityId || undefined,
        communityName: meta?.communityName,
        categoryId: chat.categoryId || meta?.categoryID || undefined,
 canPost: meta?.canPost,
        kind: parseKind(meta?.description).kind,
        unreadCount: chat.unviewedMessagesCount || 0,
      });
      continue;
    }

    items.push({
      id: chat.id,
      name: nameFor(chat),
      lastMessage: chat.lastMessage?.text || '',
      sortTs: activityTs(chat),
      type: isDirectMessage(chat) ? 'direct' : 'channel',
      categoryId: chat.categoryId || undefined,
      unreadCount: chat.unviewedMessagesCount || 0,
      isPendingRequest:
 chat.active === false && chat.lastMessage?.contactRequestState === 1,
    });
  }

  // Один id — одна строка: дубль не должен стать вторым элементом, иначе
  // удаление одной строки уберёт обе.
  const seen = new SvelteSet<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Загружает чаты, сообщества и контакты (для имён).
 * @param force - если true, игнорирует флаг loaded.
 *
 * ## Защита от параллельных вызовов
 *
 * Вызовов много и каждый тянет три RPC. Сигналы `messages.new` приходят
 * пачками, и без защиты получается каскад одинаковых запросов: в логе было
 * шесть подряд с интервалом 5–7 мс.
 *
 * Если загрузка уже идёт, `force` не запускает вторую — он только помечает,
 * что после текущей нужна ещё одна. Так обработка сигнала не теряется и
 * лишних запросов не появляется.
 */
let inFlight: Promise<void> | null = null;
let pendingReload = false;

export async function loadChats(force = false): Promise<void> {
  if (!statusState.backendPort) return;
  if (chatsState.loaded && !force) return;

  if (inFlight) {
    // Уже грузимся: запоминаем, что после завершения нужен ещё один проход.
    if (force) pendingReload = true;
    return inFlight;
  }

  inFlight = (async () => {
    // Порт проверен выше, но TypeScript этого не видит: сужение не
    // переживает границу замыкания. Фиксируем значение один раз.
    const port = statusState.backendPort as number;
    chatsState.isLoading = true;
    try {
      const [previews, contactsRes, communities] = await Promise.all([
        getChats(port),
        getContacts(port),
        // `getCommunities` (`wakuext_communities` = `All()`), а не
        // `getJoinedCommunities`: последний — это `WHERE c.joined`, и каналы
        // просматриваемого сообщества (spectate) в него не попадают. Их чаты
        // при этом лежат в `wakuext_chats` и читаются, поэтому без этой
        // замены каналы Logos «до вступления» выпадали из группировки и
        // выглядели как обычные каналы без заголовка сообщества.
        getCommunities(port).catch((e) => {
          warn('[chats] communities failed:', e);
          return [] as Community[];
        }),
      ]);

      info(
        `[chats] loaded chats=${previews.length} contacts=${contactsRes.result?.length ?? 0} ` +
          `communities=${communities.length}`
      );

      // Диагностика: без этого невозможно понять, почему канал не виден.
      // Показываем типы и активность — но не содержимое сообщений.
      for (const c of previews) {
        debug(
          `[chats] chat id=${c.id} name=${c.name} type=${c.chatType} ` +
            `active=${c.active} muted=${c.muted} community=${c.communityId || '-'}`
        );
      }

      chatsState.contacts = contactsRes.result || [];
      chatsState.communities = communities;
      chatsState.items = buildItems(previews, chatsState.contacts, communities);

      info(`[chats] items after merge: ${chatsState.items.length}`);

      chatsState.loaded = true;
    } catch (e) {
      warn('Failed to load chats:', e);
    } finally {
      chatsState.isLoading = false;
    }
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
    // Пока мы грузились, мог прийти сигнал — отрабатываем его один раз.
    if (pendingReload) {
      pendingReload = false;
      await loadChats(true);
    }
  }
}

/**
 * Создаёт канал АКК и открывает его.
 *
 * Канал — это техническое сообщество с одним каналом (см. `status/akk.ts`).
 * Пользователь этого не видит: он создал канал и сразу может в него писать.
 *
 * Канал сразу отмечаем как добавленный: иначе `buildItems` спрячет его,
 * потому что каналы сообществ в список попадают только по отметке.
 */
export async function createAndOpenChannel(
  params: CreateChannelParams
): Promise<{ ok: boolean; error?: string }> {
  const port = statusState.backendPort;
  if (!port) return { ok: false, error: 'Backend is not running' };

  const invalid = validateChannelInput(params.name, params.description);
  if (invalid) return { ok: false, error: invalid };

  const scenario = params.kind === 'news' ? 'create-auto' : 'create-request';
  scenarioLog(scenario, '1-start', { name: params.name, kind: params.kind });

  try {
    const created = await createChannel(port, params);
    scenarioLog(scenario, '2-created', {
      communityId: short(created.communityId),
      chatId: short(created.chatId),
    });
    await loadChats(true);
    const inList = chatsState.items.some((c) => c.id === created.chatId);
    scenarioLog(scenario, '3-in-list', { inList, items: chatsState.items.length },
      inList ? 'info' : 'warn');
    chatsState.selected =
      chatsState.items.find((c) => c.id === created.chatId) ?? null;
    return { ok: true };
  } catch (e) {
    scenarioLog(scenario, 'error', { error: formatError(e) }, 'warn');
    warn('[chats] create channel failed:', e);
    return { ok: false, error: formatError(e) };
  }
}

/**
 * Выбирает чат по id (если он есть в списке).
 */
export function selectChat(chatId: string) {
  // Сначала список чатов. Внешние подписки в `items` не лежат — они приходят
  // из `feedsStore`, поэтому без второй ветки открытие ленты из панели dApp
  // выбирало бы `null`, и раздел «Чат» показывал бы пустоту.
  const chat =
    chatsState.items.find((c) => c.id === chatId) ||
    feedChatItems().find((c) => c.id === chatId) ||
    null;
  chatsState.selected = chat as ChatItem | null;
}

/**
 * Выбирает объект чата напрямую.
 */
/**
 * Принимает входящий запрос на 1-1 и открывает этот чат.
 *
 * После accept контакт становится активным, но список и выбор не обновляются
 * сами: без явного `setSelectedChat` правая панель оставалась бы на экране
 * запроса, а слева чат появлялся без выбора.
 */
export async function acceptRequestAndOpen(item: ChatItem, port: number, publicKey: string): Promise<void> {
  await acceptContactRequestRpc(port, publicKey);
  await loadChats(true);
  const fresh = chatsState.items.find((c) => c.id === item.id) ?? null;
  setSelectedChat(fresh);
  scenarioLog('reply-sync', 'accepted', { chat: short(item.id), opened: !!fresh }, 'info');
}

/**
 * Отклоняет входящий запрос. Запрос исчезает из списка, а правая панель
 * возвращается к начальному состоянию «выберите чат».
 */
export async function rejectRequest(item: ChatItem, port: number, publicKey: string): Promise<void> {
  await declineContactRequestRpc(port, publicKey);
  if (chatsState.selected?.id === item.id) setSelectedChat(null);
  await loadChats(true);
  scenarioLog('reply-sync', 'rejected', { chat: short(item.id) }, 'info');
}

/** Переключает правую панель раздела «Чат». */
export function setRightPanel(mode: RightPanel) {
  chatsState.rightPanel = mode;
}

export function setSelectedChat(chat: ChatItem | null) {
  chatsState.selected = chat;
  // Выбор чата возвращает правую панель к переписке.
  if (chat) chatsState.rightPanel = 'chat';
  // Открытие чата = прочитано: сбрасываем счётчик непрочитанных на бэкенде.
  // Без этого «1» висит до перезагрузки списка и возвращается с ним.
  if (chat && chat.unreadCount && statusState.backendPort) {
    markChatRead(statusState.backendPort, chat.id).catch(() => {});
    chatsState.items = chatsState.items.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c));
  }
}

/** Сообщество, к которому относится выбранный чат (или null). */
export function selectedCommunity(): Community | null {
  const id = chatsState.selected?.communityId;
  if (!id) return null;
  return chatsState.communities.find(c => c.id === id) || null;
}

// ===========================================================================
// ПОДКЛЮЧЕНИЕ
// ===========================================================================

// `joinChannel` удалён намеренно.
//
// Он вызывал `createPublicChat`, то есть создавал публичный канал по имени:
// без владельца, без прав, без проверки существования (`CreatePublicChat.
// Validate` требует лишь непустой id). Опечатка давала пустой, но валидный
// чат, а найти канал можно было только по точному имени — каталога публичных
// каналов не существует ни в status-go, ни в SIM.
//
// Для схемы АКК это непригодно: «канал с автором» требует, чтобы автор мог
// ограничить запись, а в публичном канале такого механизма нет вовсе.
//
// Уже существующие публичные чаты (`#status` и подобные) остаются в списке и
// читаются: их тип `channel` в `ChatItem` сохранён. Удалён только путь
// СОЗДАНИЯ новых из интерфейса.

/**
 * Просматривает сообщество без вступления (`wakuext_spectateCommunity`).
 *
 * Это то, что делает SIM, когда канал Logos виден до вступления: ставится
 * `Spectated = true`, инициализируются фильтры, создаются записи `Chat`
 * для каналов. Сообщения начинают приходить и читаются.
 *
 * Писать после этого нельзя: `CanView` для неучастника возвращает `false`,
 * и интерфейс прячет поле ввода.
 *
 * Состояние сохраняется в базу status-go, поэтому просмотр переживает
 * перезапуск. Убрать — `leaveCommunity`.
 *
 * @param channelId UUID канала из `cc/`-ссылки. После загрузки списка
 *   выбираем канал с этим id: ссылка ведёт к сообществу, но пользователь
 *   ожидает оказаться в конкретном канале. Если канала нет (переименован,
 *   скрыт правами) — молча остаёмся на списке, это не ошибка подключения.
 */
/**
 * Заявка в контакты по ключу из ссылки `status.app/u/…#<ключ>`.
 *
 * Ключ — multibase base58btc, как у сообщества; разбираем тем же кодом.
 * Заявку отправляет status-go. Чат появится после принятия контакта.
 */
export async function requestContactById(rawKey: string): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };

  const publicKey = communityIdFromInvite(`#${rawKey}`);
  if (!/^0x[0-9a-fA-F]{66}$/.test(publicKey)) {
    return { status: 'failed', error: 'Не удалось разобрать ключ контакта' };
  }

  scenarioLog('reply-sync', 'contact-request-1-start', { contact: short(publicKey) });
  try {
    await sendContactRequest(statusState.backendPort, publicKey, '');
    scenarioLog('reply-sync', 'contact-request-2-sent', { contact: short(publicKey) });
    await loadChats(true);
    return { status: 'contact', name: short(publicKey) };
  } catch (e) {
    const error = formatError(e);
    scenarioLog('reply-sync', 'contact-request-error', { error }, 'warn');
    return { status: 'failed', error };
  }
}

export async function spectateCommunityById(
  rawId: string,
  channelId?: string | null
): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };

  const communityId = rawId.trim();
  if (!communityId) return { status: 'failed', error: 'Empty community id' };

  chatsState.isJoining = true;
  chatsState.joinError = '';
  try {
    // Сообщество должно быть известно локально, иначе spectate ответит
    // «not found». `waitForResponse: false` — не ждём сеть, id обычно уже
    // есть из каталога.
    const community = await fetchCommunity(statusState.backendPort, communityId).catch(() => null);

    await spectateCommunity(statusState.backendPort, communityId);
    await loadChats(true);

    // Открываем канал, если он пришёл в ссылке. `chatId` в списке — склейка
    // `communityId + channelId` (см. `communityChatId`), поэтому ищем по
    // префиксу сообщества, а не сравнением с голым UUID.
    if (channelId) {
      const targetId = communityChatId(communityId, channelId);
      // Отмечаем до поиска: иначе фильтр «чужой канал — только открытые» не
      // пропустит канал, который пользователь только что открыл по ссылке.
      markChannelOpened(targetId);
      await loadChats(true);
      // Ссылка ведёт к конкретному каналу — пользователь хочет его видеть.
      // Канал, удалённый у нас (`deactivateChat`), спектация сама не возвращает:
      // она пропускает уже известное сообщество. Выход и повторная спектация
      // снова создают его каналы активными. Выход деактивирует все каналы
      // сообщества, поэтому делаем его только если нужного канала нет в списке.
      if (!chatsState.items.some((i) => i.id === targetId)) {
        scenarioLog('create-request', 'reopen-1-leave', { community: short(communityId) });
        await leaveCommunity(statusState.backendPort, communityId);
        await spectateCommunity(statusState.backendPort, communityId);
        await loadChats(true);
      }

      const target = chatsState.items.find((i) => i.id === targetId);
      if (target) {
        // Отмечаем открытым: после перезагрузки канал останется в списке, а
        // остальные каналы этого чужого сообщества — скрыты.
        markChannelOpened(targetId);
        chatsState.selected = target;
        debug(`[chats] opened channel ${channelId} from invite link`);
      } else {
        warn(`[chats] channel ${channelId} not found in ${communityId}`);
      }
    }

    return { status: 'spectated', name: community?.name || communityId };
  } catch (e) {
    const error = formatError(e);
    chatsState.joinError = error;
    return { status: 'failed', error };
  } finally {
    chatsState.isJoining = false;
  }
}

/**
 * Сколько адресов раскрыть и какие.
 *
 * `wakuext_requestToJoinCommunity` требует непустой список адресов и
 * `airdropAddress` внутри него — то есть «просто вступить» без выбора
 * адреса нельзя. Поэтому выбор адресов неизбежен, и решать его должен
 * интерфейс, а не стор.
 */
export interface JoinAddresses {
  addressesToReveal: string[];
  airdropAddress: string;
}

/**
 * Отправляет заявку на вступление в сообщество.
 *
 * ## Почему не `wakuext_joinCommunity`
 *
 * `Manager.JoinCommunity` только ставит `Joined = true` в локальной базе
 * (communities/manager.go). Никакого сообщения владельцу он не отправляет:
 * вызывается либо когда control node уже принял заявку и прислал
 * `RequestToJoinResponse` (messenger_handler.go:1705), либо владельцем
 * своего же сообщества. Для чужого сообщества он даёт флаг без доступа —
 * каналы не появятся, потому что ключи не выданы.
 *
 * Правильный путь — `requestToJoinCommunity`, и для открытых сообществ тоже:
 * в status-go «всегда нужно просить доступ», а `AUTO_ACCEPT` означает лишь,
 * что заявку примет сам control node без участия человека.
 *
 * ## Три шага и пароль посередине
 *
 * Подпись адресов делает status-go, но пароль проверяет тоже он:
 * `Messenger.SignData` вызывает `GetVerifiedWalletAccount(address, password)`.
 * Без пароля подписи не будет, а заявка без подписей отбрасывается
 * владельцем как неподтверждённая.
 */
export async function requestJoinCommunity(
  communityId: string,
  addresses: JoinAddresses,
  password: string
): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };
  if (!addresses.addressesToReveal.length) {
    return { status: 'failed', error: 'Select at least one address' };
  }
  if (!addresses.airdropAddress) {
    return { status: 'failed', error: 'Select an airdrop address' };
  }

  const port = statusState.backendPort;
  chatsState.isJoining = true;
  chatsState.joinError = '';
  scenarioLog('create-request', 'join-1-start', { community: short(communityId) });
  try {
    const community = await fetchCommunity(port, communityId).catch(() => null);
    const name = community?.name || communityId;
    scenarioLog('create-request', 'join-2-fetched', {
      name,
      access: community?.permissions?.access ?? null,
      canRequestAccess: community?.canRequestAccess ?? null,
    });

    const toSign = await generateJoiningRequestsForSigning(
      port,
      statusState.publicKey || '',
      communityId,
      addresses.addressesToReveal
    );

    // Подписываем только те адреса, для которых бэкенд вернул данные.
    // `personal.SignParams` пропускает chat-аккаунты и watch-only, поэтому
    // ответ может оказаться короче запрошенного списка — а порядок подписей
    // в заявке обязан совпадать с порядком адресов.
    const signable = toSign.filter((p) => !!p.data);
    if (!signable.length) {
      throw new Error('No address can be revealed: watch-only and chat accounts cannot sign');
    }

    const signatures = await signJoinRequestData(port, signable, password);
    if (signatures.length !== signable.length) {
      throw new Error('Signature count does not match address count');
    }

    const revealed = signable.map((p) => p.account || '');
    // airdropAddress обязан входить в раскрываемые; если пользователь выбрал
    // адрес, который подписать нельзя, отправляем заявку с подписываемым.
    const airdrop = revealed.includes(addresses.airdropAddress)
      ? addresses.airdropAddress
      : revealed[0];

    scenarioLog('create-request', 'join-3-signed', { addresses: revealed.length });
    const reqRes = await requestToJoinCommunity(port, communityId, revealed, signatures, airdrop);
    scenarioLog('create-request', 'join-4-sent', {
      ok: !!reqRes,
      error: reqRes?.error?.message ?? null,
    }, reqRes?.error ? 'warn' : 'info');
    await loadChats(true);

    // Открытое сообщество (`AUTO_ACCEPT`) принимает заявку само, но ответ
    // приходит асинхронно, по сигналу. Поэтому «joined» здесь означало бы
    // обман: сообщаем «заявка отправлена», а канал появится, когда владелец
    // (или его автоматика) ответит.
    return { status: 'requested', name };
  } catch (e) {
    const error = formatError(e);
    scenarioLog('create-request', 'join-error', { error }, 'warn');
    chatsState.joinError = error;
    return { status: 'failed', error };
  } finally {
    chatsState.isJoining = false;
  }
}

/**
 * Проверяет, подходят ли адреса под условия сообщества.
 *
 * Отдаёт то, что нужно экрану «You are eligible to join as member» и
 * «Select address to share»: `satisfied` и список прошедших адресов.
 */
export async function checkJoinEligibility(
  communityId: string,
  addresses: string[] = []
): Promise<{ satisfied: boolean; addresses: string[]; networksNotSupported: boolean }> {
  if (!statusState.backendPort) {
    return { satisfied: false, addresses: [], networksNotSupported: false };
  }
  const res = await checkPermissionsToJoinCommunity(
    statusState.backendPort,
    communityId,
    addresses
  );
  return {
    satisfied: res.satisfied,
    addresses: res.validCombinations.map((c) => c.address),
    networksNotSupported: res.networksNotSupported,
  };
}

/**
 * Подключается к сообществу по введённой строке.
 *
 * Единая точка входа для поля «подключиться»:
 *   * ссылка-приглашение Status (`status.app/c/…#zQ3…`) — сообщество;
 *   * `0x…` (66+ символов) — сообщество;
 *   * всё остальное — отказ с объяснением.
 *
 * ## Почему больше нет подключения по имени канала
 *
 * Раньше всё остальное уходило в `joinChannel` → `createPublicChat`, то есть
 * создавало публичный канал. Такой канал не имеет владельца: его нельзя
 * закрыть, переименовать или запретить писать в него, а найти можно только
 * по точному имени — каталога публичных каналов не существует.
 *
 * Для схемы АКК это непригодно, а пользователю — вредно: опечатка создавала
 * пустой, но «валидный» чат, неотличимый от канала, где просто молчат.
 * Поэтому ввод, который не является ссылкой или `0x`-id, теперь возвращает
 * понятный отказ, а не мусорный чат.
 *
 * Разбор ссылки — в `communityIdFromInvite`: ключ лежит после `#` в
 * base58btc, а не после `/c/` в base64 (см. комментарий там). Раньше здесь
 * регулярка `\/c[#/]([A-Za-z0-9]+)` хватала base64-часть и обрезала её на
 * первом `_` — то есть в `fetchCommunity` уходил мусор.
 *
 * Для сообщества действие — **просмотр**, а не вступление: вступление
 * требует выбора адресов и пароля, поэтому оно вынесено в
 * `requestJoinCommunity` и запускается с экрана превью. Так «показать, что
 * внутри» и «вступить» не смешиваются в одном необратимом действии.
 */
export async function joinByInput(raw: string): Promise<JoinResult> {
  const value = raw.trim();
  if (!value) return { status: 'failed', error: 'Empty input' };

  // Ссылка-приглашение. Форматы в обращении:
  //   status.app/c/<base64>#<base58btc>  — сообщество, из «Share community»;
  //   status.app/c#<ключ>                — сообщество, без base64-части;
  //   status.app/cc/<uuid>#<ключ>        — канал, UUID текстом;
  //   status.app/cc/<brotli>#<ключ>      — канал, описание в сжатом protobuf.
  //
  // Канальная ссылка тоже ведёт к сообществу: канал внутри сообщества
  // адресуется парой «UUID + ключ», и без сообщества ссылка не имеет смысла.
  // Но пользователь ожидает оказаться в конкретном канале, поэтому UUID
  // передаём дальше — после загрузки списка он откроется.
  //
  // Сжатый вариант разбирает Rust (`parseChannelInvite`): в webview brotli
  // не декодируется.
  // Контакт: профиль из «Share profile». Отправляем заявку в контакты; чат
  // появится, когда контакт примет её (см. docs/ru/akk_scheme.md).
  const contactMatch = value.match(/status\.app\/u\/[^#\s]*#(\S+)/i);
  if (contactMatch) {
    return await requestContactById(contactMatch[1]);
  }

  // Голый ключ контакта — так Invite a contact показывает его на Android:
  // base58btc с префиксом `z` (zQ3sh…) или `0x`-hex сжатого ключа.
  // Проверяем после ссылок: ссылка на канал содержит `#` и уже разобрана выше.
  if (/^z[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(value) || /^0x[0-9a-fA-F]{66}$/.test(value)) {
    return await requestContactById(value);
  }

  if (/status\.app\/cc\//i.test(value)) {
    const parsed = await parseChannelInvite(value).catch(() => null);
    return await spectateCommunityById(
      communityIdFromInvite(value),
      parsed?.channelId ?? channelIdFromInvite(value)
    );
  }

  if (/status\.app\/c(?:[/#])/i.test(value)) {
    return await spectateCommunityById(communityIdFromInvite(value));
  }

  // Явный hex-идентификатор сообщества.
  if (/^0x[0-9a-fA-F]{64,}$/.test(value)) {
    return await spectateCommunityById(value);
  }

  // Ссылка на профиль/канал Telegram намеренно НЕ обрабатывается здесь:
  // это внешний источник, а не канал Status. См. providers_and_dapps.md §9.
  return {
    status: 'failed',
    error:
      'Вставьте ссылку на канал (status.app/cc/…). Найти канал по имени нельзя: каталога каналов нет.',
  };
}

/**
 * Убирает чат из списка.
 *
 * ## Что именно удаляется
 *
 * Для канала сообщества — `deactivateChat` без истории: канал перестаёт
 * приходить и исчезает из списка. История не подтягивается заново.
 * Чат в status-go остаётся: канал можно снова открыть из каталога, и история
 * при этом цела. Так «убрать с глаз» и «стереть историю» перестают быть
 * одним действием, что важно — раньше удаление из списка необратимо стирало
 * переписку.
 *
 * Для публичного канала (`type: 'channel'`) — `deactivateChat`, и это
 * единственный способ «отписаться»: владельца у такого канала нет, удалить
 * его для всех нельзя, а отметки у него не предусмотрено — он попадает в
 * список по факту существования.
 *
 * Уйти из сообщества целиком — отдельное действие (`leaveCommunityById`):
 * оно снимает участие, чего случайным нажатием делать не хочется.
 */
export async function removeChat(item: ChatItem): Promise<{ ok: boolean; error?: string }> {
  // Канал сообщества: снимаем отметку и перестраиваем список без обращения к
  // бэкенду. `deactivateChat` здесь был бы необратим: `preserveHistory` по
  // умолчанию не сохраняет историю.
  if (item.type === 'community') {
    if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };
    // Деактивация в status-go: канал перестаёт приходить и исчезает из списка.
    // История не сохраняется и заново не подтягивается (решение пользователя).
    try {
      await deactivateChat(statusState.backendPort, item.id, false);
    } catch (e) {
      const error = formatError(e);
      scenarioLog('create-auto', 'remove-failed', { channel: short(item.id), error }, 'warn');
      return { ok: false, error };
    }
    chatsState.items = chatsState.items.filter((c) => c.id !== item.id);
    if (chatsState.selected?.id === item.id) chatsState.selected = null;
    info(`[chats] deactivated channel ${short(item.id)}`);
    return { ok: true };
  }

  if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };

  try {
    await deactivateChat(statusState.backendPort, item.id);
    // Убираем сразу, не дожидаясь перезагрузки: она бывает долгой, а
    // пользователь ждёт мгновенного результата.
    chatsState.items = chatsState.items.filter((c) => c.id !== item.id);
    if (chatsState.selected?.id === item.id) chatsState.selected = null;
    chatsState.loaded = false;
    info(`[chats] removed chat ${item.id}`);
    return { ok: true };
  } catch (e) {
    const error = formatError(e);
    warn(`[chats] failed to remove ${item.id}:`, error);
    return { ok: false, error };
  }
}

/**
 * Покидает сообщество целиком.
 *
 * `leaveCommunity` очищает оба флага (`joined` и `spectated`) — см.
 * `Community.Leave()` в status-go. После этого каналы сообщества исчезают из
 * списка, а вернуться можно только по новой ссылке.
 *
 * Это необратимее скрытия канала, поэтому вызывается отдельной кнопкой с
 * подтверждением, а не тем же действием, что «убрать из списка».
 */
export async function leaveCommunityById(
  communityId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };

  try {
    await leaveCommunity(statusState.backendPort, communityId);
    chatsState.items = chatsState.items.filter((c) => c.communityId !== communityId);
    if (chatsState.selected?.communityId === communityId) chatsState.selected = null;
    chatsState.loaded = false;
    info(`[chats] left community ${communityId}`);
    return { ok: true };
  } catch (e) {
    const error = formatError(e);
    warn(`[chats] failed to leave ${communityId}:`, error);
    return { ok: false, error };
  }
}

export function resetChats() {
  chatsState.items = [];
  chatsState.contacts = [];
  chatsState.communities = [];
  chatsState.selected = null;
  chatsState.loaded = false;
  chatsState.isLoading = false;
  chatsState.isJoining = false;
  chatsState.joinError = '';
}
