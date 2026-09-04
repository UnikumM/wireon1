/**
 * «На другом устройстве что-то изменилось» — одним коротким сообщением.
 *
 * Зачем это поверх обычной сверки. Сверка ходит по расписанию: раз в минуту
 * и при возвращении в приложение. Для «поставил сердечко на компьютере — увидел
 * на телефоне» этого мало: минута ожидания читается как «не работает», особенно
 * рядом со Spotify, где то же самое происходит мгновенно. Разница у них не в
 * скорости сети, а в устройстве связи: там устройство **слушает** сервер, а не
 * спрашивает его.
 *
 * Слушать нам есть чем — брокер для совместного прослушивания уже написан,
 * поднят и умеет держать соединение с переподключением. Здесь он используется
 * как звонок: одно устройство говорит «я изменил медиатеку», остальные тут же
 * идут за настоящими данными по обычной защищённой ручке `/v1/sync`.
 *
 * **Через брокер не проходит ни одного байта содержимого.** И это не
 * осторожность впрок: у брокера нет разграничения по темам, а токен приложения
 * лежит внутри APK — то есть подписаться на чужую тему может любой, кто
 * распаковал сборку. Поэтому в сообщении только отметка времени и случайный
 * номер устройства, а сама медиатека ездит там, где личность подтверждает
 * Discord.
 *
 * По той же причине **публичные брокеры сюда не годятся**, хотя совместное
 * прослушивание на них работает: там секрет — код комнаты, который человек сам
 * кому-то дал, а здесь тема выводится из личности. Нет своего брокера — нет и
 * звонка, остаётся обычная сверка по расписанию.
 */

import { MqttClient, WebSocketLike } from './mqttClient';

/** Тема выводится из личности, поэтому имя в открытом виде туда не уходит. */
const TOPIC_PREFIX = 'wireon/lib/';

/** Чаще этого звонок не звонит: правки идут пачками, а звонок нужен один. */
const NOTIFY_THROTTLE_MS = 2000;

/** Столько живёт соединение без единого пакета, прежде чем брокер его закроет. */
const KEEP_ALIVE_SECONDS = 60;

export interface LibrarySignalOptions {
  /** Идентификатор Discord: из него выводится тема, но в неё не попадает. */
  userId: string;
  /** Позвали, когда изменение пришло с другого устройства. */
  onNudge: () => void;
  /** Только для тестов: свой брокер вместо настроенного. */
  endpoints?: string[];
  /** Только для тестов: поддельный сокет. */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * Только для тестов: схема страницы. В jsdom `location.protocol` подменить
   * нечем, а проверка «незащищённый брокер со страницы по https» — ровно то,
   * из-за чего звонок не работал на телефоне, и без проверки её оставлять
   * нельзя.
   */
  pageProtocol?: string;
}

interface Nudge {
  /** Кто позвонил. Своё эхо мы пропускаем: сверять нечего, мы и так отправили. */
  device: string;
  at: number;
}

let client: MqttClient | null = null;
let offMessage: (() => void) | null = null;
let currentTopic = '';
let lastNotifyAt = 0;

/**
 * Номер попытки подключения.
 *
 * Между «остановить прежнее» и «подключить новое» есть `await` — счёт темы. Два
 * вызова подряд (вход и следом восстановление сессии) успевают в этот зазор
 * оба, и без номера первый оставил бы за собой живой сокет, на который уже
 * никто не смотрит.
 */
let generation = 0;

/** Почему звонка сейчас нет. Показывается человеку в настройках аккаунта. */
export type LibrarySignalStatus =
  /** Подключён, изменения приходят сразу. */
  | 'online'
  /** Не пробовали: нет входа или брокер не настроен. */
  | 'idle'
  /** Этому устройству такой канал недоступен в принципе. См. `wsBlockedHere`. */
  | 'unsupported'
  /** Пробовали, не вышло: сеть, брокер, что угодно поправимое. */
  | 'offline';

let status: LibrarySignalStatus = 'idle';

/**
 * Кто мы на этом брокере. Случайный и на один запуск: два окна одного
 * компьютера должны отличаться, иначе брокер выгонит одно другим.
 */
const deviceId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Может ли этот браузер вообще открыть такое соединение.
 *
 * На телефоне страница живёт на `https://localhost` (`androidScheme: 'https'`,
 * без этого WebView урезает Web Audio и mediaSession), а брокер у нас `ws://`.
 * Chromium запрещает незащищённый WebSocket со страницы по https — и отказывает
 * **при создании объекта**, до всякой сети. Замерено на устройстве 2026-09-02:
 * «An insecure WebSocket connection may not be initiated from a page loaded
 * over HTTPS». На настольной сборке страница отдаётся по `file://`, где этого
 * запрета нет, — оттуда всё работает.
 *
 * Обычные запросы к серверу при этом проходят: Capacitor уводит их в нативный
 * слой мимо правил страницы (проверено там же: `/health` вернул 200).
 * WebSocket так увести нечем.
 *
 * Поэтому здесь мы не пытаемся и не сыплем ошибкой в журнал на каждом входе, а
 * честно говорим наверх: канала нет, остаётся сверка по расписанию.
 */
export function wsBlockedHere(endpoint: string, pageProtocol?: string): boolean {
  const protocol =
    pageProtocol ?? (typeof location === 'undefined' ? undefined : location.protocol);
  if (!protocol) return false;
  return protocol === 'https:' && endpoint.toLowerCase().startsWith('ws://');
}

/**
 * Свой брокер и только он. Без настройки звонка нет — см. шапку файла.
 */
function configuredEndpoint(): string | null {
  let raw: string | undefined;
  try {
    raw = import.meta.env?.VITE_WIREON_MQTT_URL as string | undefined;
  } catch {
    raw = undefined; // сборщик не подставил env — например, под обычным Node
  }
  const first = (raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .find((url) => /^wss?:\/\//i.test(url));
  return first ?? null;
}

/**
 * Тема для этой личности.
 *
 * Хэш, а не сам идентификатор: тема видна любому, кто подключился к брокеру, и
 * список тем — это список тех, кто сейчас в сети. Хэш превращает его в набор,
 * по которому нельзя ни узнать человека, ни перебрать чужие темы.
 */
export async function topicForUser(userId: string): Promise<string | null> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (!subtle || typeof subtle.digest !== 'function') {
    /*
     * Запасного способа посчитать тему здесь намеренно нет.
     *
     * Своя простая свёртка выглядела бы безобиднее, но она даёт **другую**
     * тему: устройство без `crypto.subtle` слушало бы одно, а остальные писали
     * бы в другое — и звонок молча не приходил бы никогда. Отсутствие звонка
     * заметно и объяснимо, расхождение тем — нет.
     */
    console.info('[librarySignal] Нет crypto.subtle — мгновенный звонок недоступен, остаётся сверка по расписанию.');
    return null;
  }
  try {
    const bytes = new TextEncoder().encode(`wireon-library:${userId}`);
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest.subarray(0, 12))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `${TOPIC_PREFIX}${hex}`;
  } catch (err) {
    console.info('[librarySignal] Тему посчитать не вышло:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Подключается к брокеру и слушает звонки для этой личности.
 *
 * @returns удалось ли подключиться. `false` — это не беда: сверка по
 *   расписанию работает и без звонка, просто медленнее.
 */
export async function startLibrarySignal(options: LibrarySignalOptions): Promise<boolean> {
  stopLibrarySignal();
  if (!options.userId) return false;
  const mine = ++generation;

  const endpoints = options.endpoints ?? (configuredEndpoint() ? [configuredEndpoint() as string] : []);
  if (endpoints.length === 0) {
    console.info(
      '[librarySignal] Свой брокер не настроен — медиатека будет сходиться по расписанию, без мгновенного звонка.'
    );
    status = 'idle';
    return false;
  }

  if (endpoints.every((endpoint) => wsBlockedHere(endpoint, options.pageProtocol))) {
    console.info(
      '[librarySignal] Незащищённый WebSocket со страницы по https запрещён браузером — ' +
        'мгновенных обновлений здесь не будет, остаётся сверка по расписанию.'
    );
    status = 'unsupported';
    return false;
  }

  const topic = await topicForUser(options.userId);
  if (!topic) {
    status = 'unsupported';
    return false;
  }
  if (mine !== generation) return false;
  currentTopic = topic;
  const created = new MqttClient({
    endpoints,
    clientId: `wireon_lib_${deviceId}`.slice(0, 64),
    keepAliveSeconds: KEEP_ALIVE_SECONDS,
    socketFactory: options.socketFactory
  });
  client = created;

  offMessage = created.onMessage((incomingTopic, payload) => {
    if (incomingTopic !== currentTopic) return;
    let nudge: Nudge | null = null;
    try {
      nudge = JSON.parse(payload) as Nudge;
    } catch {
      return; // не наше сообщение — молча пропускаем
    }
    // Своё эхо игнорируем: мы и так только что отправили изменения.
    if (!nudge || nudge.device === deviceId) return;
    options.onNudge();
  });

  created.subscribe(currentTopic);

  try {
    await created.connect();
    if (mine !== generation) {
      created.end();
      return false;
    }
    status = 'online';
    return true;
  } catch (err) {
    console.info(
      '[librarySignal] До брокера не достучались, остаётся сверка по расписанию:',
      err instanceof Error ? err.message : err
    );
    status = 'offline';
    return false;
  }
}

/**
 * Звонит остальным устройствам этого человека.
 *
 * Молчит, если соединения нет: звонок — ускорение, а не условие работы, и
 * ронять из-за него отправку изменений незачем.
 */
export function notifyLibraryChanged(): void {
  if (!client || !currentTopic) return;
  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) return;
  lastNotifyAt = now;
  const nudge: Nudge = { device: deviceId, at: now };
  client.publish(currentTopic, JSON.stringify(nudge));
}

export function stopLibrarySignal(): void {
  generation += 1;
  status = 'idle';
  offMessage?.();
  offMessage = null;
  client?.end();
  client = null;
  currentTopic = '';
  lastNotifyAt = 0;
}

/** Подключён ли звонок прямо сейчас. Нужно диагностике и тестам. */
export function isLibrarySignalOnline(): boolean {
  return client?.status === 'online';
}

/**
 * Почему звонка нет — чтобы экран говорил «здесь так нельзя», а не «нет связи».
 *
 * Разница не косметическая: «нет связи» человек идёт чинить, а недоступность
 * канала на этом устройстве чинить нечем, и знать об этом полезнее.
 */
export function librarySignalStatus(): LibrarySignalStatus {
  if (client?.status === 'online') return 'online';
  return status;
}
