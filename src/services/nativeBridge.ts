/**
 * Единственное место, где приложение решает, кто добывает звук и метаданные.
 *
 * На десктопе это главный процесс: `window.electronAPI` ходит к yt-dlp и к
 * InnerTube в обход CORS. На телефоне главного процесса нет вовсе, поэтому
 * поиск и радио уходят на наш сервер (`server/wireon_music`), а он делает ровно
 * то же самое и возвращает те же формы ответов.
 *
 * Формы ответов совпадают не случайно, и это главное решение этого файла.
 * `youtube.ts` уже умеет разбирать сырой InnerTube и выправлять ссылку из IPC;
 * второй разбор под телефон означал бы два места, обязанных угадать одну и ту же
 * структуру одинаково, — а расходиться они начнут в первый же день, когда
 * YouTube что-нибудь переставит. Поэтому сервер отдаёт сырое, а мост только
 * переносит.
 *
 * Ссылка на аудио — исключение, и важное. Её телефон сначала добывает **сам**
 * (`youtubeOnDevice.ts`), а не просит у сервера: ссылка, выданная серверу,
 * содержит его адрес и подписана вместе с ним, поэтому с телефона отвечает 403.
 * Подробности замера — в шапке того файла. Сервер остаётся ради радио, поиска и
 * брокера комнат: их InnerTube отдаёт кому угодно и адресом не связывает.
 *
 * Но своими силами выходит не всегда: части треков YouTube отдаёт телефону
 * ответ без пригодной ссылки. Для них здесь есть вторая ступень — спросить
 * сервер, попробовать его ссылку одним запросом на два байта и уйти на перелив
 * (`/v1/stream`) только если она действительно не открылась.
 *
 * Порядок именно такой и обратным быть не может: прямая ссылка не стоит нам ни
 * байта канала, а перелив идёт по той же полосе, что VPN. Сервер тут не
 * «надёжнее», он дороже — и потому второй, а перелив третий.
 *
 * У него при этом есть то, чего нет у телефона: cookies живого аккаунта и
 * европейский адрес. Поэтому возраст и запрет по стране — тоже повод спросить
 * его, а не сдаться.
 *
 * Чего здесь намеренно нет:
 *
 * - **SoundCloud.** У сервера такой ручки нет и не нужно: `soundcloud.ts` при
 *   отсутствии моста сам ходит запросом, а под Capacitor запрос идёт мимо CORS
 *   через нативный слой. Лишний крюк через наш адрес только добавил бы точку
 *   отказа.
 * - **Окна, горячие клавиши, мини-плеер, Discord RPC, автообновление.** Это
 *   свойства настольного окружения, а не источника музыки. На телефоне их
 *   вызовы просто не находят моста и ничего не делают — так эти места и
 *   написаны с самого начала.
 */

/** Куда телефон ходит за радио и поиском. Ссылка на аудио сервера не требует. */
const SERVER_URL_ENV = 'VITE_WIREON_SERVER_URL';
const SERVER_TOKEN_ENV = 'VITE_WIREON_SERVER_TOKEN';

/** Поиск и радио — это один запрос к InnerTube, там ждать нечего. */
const METADATA_TIMEOUT_MS = 15000;

/**
 * А вот ссылку сервер добывает через yt-dlp: две попытки по 25 секунд каждая в
 * худшем случае. Пятнадцати секунд здесь хватало бы только на быстрые треки, и
 * медленные обрывались бы по сроку — то есть выглядели бы как «не играет»
 * ровно тогда, когда запасной путь и нужен.
 */
const RESOLVE_TIMEOUT_MS = 55000;

/**
 * Проба «откроется ли ссылка отсюда» — два байта. Восьми секунд хватает и на
 * мобильной сети; дольше ждать смысла нет, потому что запасной путь всё равно
 * есть, а тишина в плеере тем временем идёт.
 */
const PROBE_TIMEOUT_MS = 8000;

export type PlatformKind = 'electron' | 'mobile' | 'browser';

/** Ровно те вызовы, которые обязаны работать вне десктопа. */
export interface StreamBridge {
  searchYouTube?: (query: string) => Promise<unknown>;
  youtubeRadio?: (videoId: string) => Promise<unknown>;
  /**
   * @param rejectUrl ссылка, которую плеер уже получил и играть не смог. На
   *   телефоне она доезжает до перебора клиентов, и ступень, выдавшая ровно её,
   *   пропускается. Главный процесс на десктопе лишний аргумент игнорирует.
   */
  resolveYouTubeStream?: (
    videoId: string,
    priority?: 'user' | 'prefetch',
    rejectUrl?: string
  ) => Promise<unknown>;
}

export interface ServerConfig {
  baseUrl: string;
  token: string;
}

function readEnv(name: string): string | undefined {
  // `import.meta.env` подставляется сборщиком, но под vitest в jsdom его может
  // не быть вовсе — обращение через `?.` дешевле, чем try/catch на каждый вызов.
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.[name];
}

/**
 * Убирает завершающие косые черты, чтобы `base + '/v1/resolve'` не давал
 * двойного слэша: сервер на такой путь отвечает 404, и выглядит это как
 * «сервер лежит», хотя лежит опечатка в настройке.
 */
export function normalizeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Настройки сервера или null, если их нет.
 *
 * Токен обязателен вместе с адресом: сервер без токена отвечает 401 на всё,
 * кроме `/health`, и половина настройки хуже, чем её отсутствие — при
 * отсутствии видно, что мобильная сборка не настроена, а при половине каждый
 * трек молча не играет.
 */
export function resolveServerConfig(
  rawUrl?: string | null,
  rawToken?: string | null
): ServerConfig | null {
  const baseUrl = normalizeBaseUrl(rawUrl ?? readEnv(SERVER_URL_ENV));
  const token = (rawToken ?? readEnv(SERVER_TOKEN_ENV) ?? '').trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/**
 * Где мы работаем.
 *
 * Capacitor кладёт в окно свой объект, и это единственный честный признак: по
 * user-agent Android-обёртка неотличима от обычного Chrome на телефоне, а
 * обычному Chrome наш сервер не нужен — там нет ни своей схемы ссылок, ни
 * фонового звука.
 */
export function detectPlatform(scope: unknown = typeof window === 'undefined' ? undefined : window): PlatformKind {
  const view = scope as
    | { electronAPI?: unknown; Capacitor?: { isNativePlatform?: () => boolean } }
    | undefined;
  if (!view) return 'browser';
  if (view.electronAPI) return 'electron';
  const capacitor = view.Capacitor;
  if (capacitor && typeof capacitor.isNativePlatform === 'function') {
    try {
      if (capacitor.isNativePlatform()) return 'mobile';
    } catch {
      // Обёртка сломана — считаем, что это обычный браузер, и работаем как в вебе.
    }
  }
  return 'browser';
}

/** Отказ сервера, пересказанный так, как его пересказал бы главный процесс. */
class ServerBridgeError extends Error {
  public readonly code: string;

  constructor(code: string, detail: string) {
    // Формат `КОД: подробности` не украшение: `describePlaybackError` в
    // `playbackErrors.ts` ищет коды `YT_*` именно в такой форме, и десктопный
    // главный процесс отдаёт их так же. Совпадение формата — это то, из-за чего
    // человек на телефоне видит «YouTube просит подтвердить, что вы не робот»,
    // а не «что-то пошло не так».
    super(`${code}: ${detail}`);
    this.name = 'ServerBridgeError';
    this.code = code;
  }
}

async function request(
  config: ServerConfig,
  path: string,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      // Заголовком, а не `?token=`: адрес с токеном оседает в журналах любого
      // прокси по дороге. `?token=` на сервере оставлен только ради WebSocket,
      // который заголовки задавать не умеет.
      headers: { 'X-Wireon-Token': config.token },
      signal: controller.signal
    });

    if (!response.ok) {
      let code = `HTTP_${response.status}`;
      let detail = `сервер ответил ${response.status}`;
      try {
        const body = (await response.json()) as { error?: unknown; detail?: unknown };
        if (typeof body?.error === 'string' && body.error) code = body.error;
        if (typeof body?.detail === 'string' && body.detail) detail = body.detail;
      } catch {
        // Тело не JSON — кода из статуса достаточно, чтобы понять, что случилось.
      }
      throw new ServerBridgeError(code, detail);
    }

    return await response.json();
  } catch (err) {
    if (err instanceof ServerBridgeError) throw err;
    // Обрыв по сроку и обрыв сети выглядят для человека одинаково — «не
    // дождались», — но код нужен разный: по первому видно, что сервер жив и
    // думает, по второму — что до него не достучались.
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ServerBridgeError(
      aborted ? 'WIREON_SERVER_TIMEOUT' : 'WIREON_SERVER_UNREACHABLE',
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ссылка на аудио силами самого телефона.
 *
 * Вынесено отдельно, потому что от настроек сервера не зависит вовсе: разбор
 * идёт на самом устройстве. Именно поэтому телефон без адреса сервера остаётся
 * со звуком — теряются только радио, поиск и вторая ступень.
 */
function onDeviceResolve(): StreamBridge {
  return {
    resolveYouTubeStream: (videoId: string, priority?: 'user' | 'prefetch', rejectUrl?: string) =>
      resolveHere(videoId, priority, rejectUrl)
  };
}

/**
 * Две попытки самого устройства: сначала yt-dlp, потом `youtubei.js`.
 *
 * Порядок именно такой, и он не про скорость. `youtubei.js` отвечает за
 * секунду-две, но замерено 2026-08-28: ни один его клиент не отдаёт ни прямой
 * ссылки, ни манифеста — только SABR, который `<audio src>` не играет. То есть
 * быстрая ступень сегодня отказывает **всегда**, и поставить её первой значит
 * добавлять эти две секунды к каждому треку впустую.
 *
 * yt-dlp медленнее — он поднимает настоящий Python, — зато прямую ссылку
 * получает. Вторая ступень оставлена не как запас надёжности, а на случай,
 * когда `youtubei.js` научится тому же: тогда порядок надо будет поменять
 * обратно, и менять придётся одну строку.
 */
async function resolveHere(
  videoId: string,
  priority: 'user' | 'prefetch' = 'user',
  rejectUrl?: string
): Promise<unknown> {
  const { isYtDlpAvailable, resolveWithYtDlp } = await import('./ytDlpOnDevice');

  if (await isYtDlpAvailable()) {
    try {
      return await resolveWithYtDlp(videoId, { priority, rejectUrl });
    } catch (error) {
      // «Видео нет» и «оно приватное» одинаковы для любой ступени: вторая
      // попытка здесь только добавит ожидания к тому же ответу.
      if (HOPELESS_CODES.has(codeOf(error))) throw error;
    }
  }

  const { resolveOnDevice } = await import('./youtubeOnDevice');
  return resolveOnDevice(videoId);
}

/**
 * Отказы, после которых спрашивать сервер незачем.
 *
 * Список короткий намеренно. «Видео нет», «оно приватное», «это эфир» и «id не
 * тот» одинаковы с любого адреса и с любыми cookies — второй запрос здесь
 * только добавит полминуты ожидания к тому же ответу.
 *
 * Возраста и запрета по стране здесь **нет**, и это не недосмотр: у сервера
 * cookies залогиненного аккаунта и адрес в Европе, поэтому ровно эти два
 * отказа он умеет обходить там, где телефон бессилен.
 */
const HOPELESS_CODES = new Set(['YT_BAD_ID', 'YT_UNAVAILABLE', 'YT_PRIVATE', 'YT_LIVE']);

/**
 * Отказы, в которых телефон назвал причину, а не просто развёл руками.
 *
 * Ровно эти два и есть повод идти к серверу — и ровно они перевешивают его
 * ответ, когда весь его ответ сводится к «подтвердите, что вы не робот».
 */
const DIAGNOSED_CODES = new Set(['YT_GEO_BLOCKED', 'YT_AGE_RESTRICTED']);

/** Код отказа из ошибки любой из двух ступеней: обе пишут `КОД: подробности`. */
function codeOf(err: unknown): string {
  const known = (err as { code?: unknown })?.code;
  if (typeof known === 'string' && known) return known;
  const message = err instanceof Error ? err.message : String(err);
  return message.split(':', 1)[0].trim();
}

/**
 * Адрес перелива для `<audio src=...>`.
 *
 * Токен уходит в строке запроса, а не заголовком, по той же причине, что и у
 * WebSocket: тег `<audio>` заголовков не задаёт. Это осознанное послабление,
 * не расширение — ручка требует того же токена, что и все остальные.
 */
export function proxyStreamUrl(config: ServerConfig, videoId: string): string {
  const id = encodeURIComponent(videoId);
  return `${config.baseUrl}/v1/stream?id=${id}&token=${encodeURIComponent(config.token)}`;
}

/**
 * Играбельна ли ссылка отсюда: просим у раздачи один байт.
 *
 * Проверкой, а не по виду ссылки, и это исправление замера от 2026-08-28.
 * Тогда было записано, что ссылка с `ip=` внутри отвечает с чужого адреса 403;
 * проверено 2026-08-28 повторно — такая ссылка (клиент `visionos`, через
 * редирект на `cms_redirect`) спокойно отдала 206 и байты с другого адреса.
 * То есть `ip=` — это подпись, а не обязательно запрет, и YouTube применяет
 * его не всегда.
 *
 * Цена ошибки здесь несимметрична, поэтому и проверяем. Решив «привязана»
 * ошибочно, мы гоним весь трек через канал, на котором живёт VPN, — ровно то,
 * чего вся эта конструкция избегает. Решив «не привязана» ошибочно, мы теряем
 * один запрос и уходим на перелив. Два байта трафика дешевле мегабайтов.
 */
async function playableFromHere(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Range: 'bytes=0-1' },
      signal: controller.signal
    });
    return response.ok;
  } catch {
    // Обрыв, запрет и отказ по сроку — для нас одно и то же: этим путём звук
    // не пойдёт, значит пойдёт через перелив.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Вторая ступень: ссылку добывает сервер.
 *
 * Ссылку, подписанную вместе с его адресом, сначала пробуем сами и уходим на
 * перелив только тогда, когда она действительно не открылась. Лишний запрос
 * здесь ничего не стоит: мы уже на медленном пути, где сервер только что
 * потратил секунды на yt-dlp.
 */
async function resolveViaServer(
  config: ServerConfig,
  videoId: string,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const payload = (await request(
    config,
    `/v1/resolve?id=${encodeURIComponent(videoId)}`,
    RESOLVE_TIMEOUT_MS,
    fetchImpl
  )) as Record<string, unknown>;

  const direct = typeof payload?.streamUrl === 'string' ? payload.streamUrl : '';
  if (payload?.ipLocked === true && direct) {
    if (await playableFromHere(direct, fetchImpl)) return payload;
    return { ...payload, streamUrl: proxyStreamUrl(config, videoId) };
  }
  return payload;
}

/**
 * Обе ступени по порядку: сначала телефон, потом сервер.
 *
 * Какую ошибку показать, когда не вышло нигде: серверную, потому что она
 * последняя и сказана стороной с большими возможностями. Кроме двух случаев,
 * когда серверный ответ ничего не объясняет:
 *
 * - до сервера просто не достучались — виноват не YouTube, и «сервер
 *   недоступен» вместо настоящей причины сбило бы с толку;
 * - сервер уткнулся в проверку «вы не робот», а телефон **успел назвать
 *   причину** — «заблокировано в вашем регионе» или «возрастное ограничение».
 *   У сервера адрес дата-центра, и эту проверку он получает почти на каждый
 *   трек: его ответ тогда говорит о нём, а не о песне. Только для этих двух
 *   кодов: они — единственные, ради которых телефон вообще идёт к серверу, и
 *   единственные, где ему есть что сказать самому. Во всех остальных случаях
 *   («SABR», «нет пригодной дорожки») сказать ему нечего, и проверка «вы не
 *   робот» остаётся честнее.
 */
function chainedResolve(config: ServerConfig, fetchImpl: typeof fetch): StreamBridge {
  return {
    resolveYouTubeStream: async (
      videoId: string,
      priority?: 'user' | 'prefetch',
      rejectUrl?: string
    ) => {
      try {
        return await resolveHere(videoId, priority, rejectUrl);
      } catch (deviceError) {
        if (HOPELESS_CODES.has(codeOf(deviceError))) throw deviceError;
        try {
          return await resolveViaServer(config, videoId, fetchImpl);
        } catch (serverError) {
          const serverCode = codeOf(serverError);
          const deviceExplainedItself = DIAGNOSED_CODES.has(codeOf(deviceError));
          const serverExplainsNothing =
            serverCode.startsWith('WIREON_SERVER_') ||
            (serverCode === 'YT_BOT_CHECK' && deviceExplainedItself);
          throw serverExplainsNothing ? deviceError : serverError;
        }
      }
    }
  };
}

/**
 * Мост поверх нашего сервера. Собирается отдельно от определения платформы,
 * чтобы тесты могли проверить его без подмены `window`.
 */
export function createServerBridge(
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch
): StreamBridge {
  return {
    ...chainedResolve(config, fetchImpl),
    searchYouTube: (query: string) =>
      request(
        config,
        `/v1/search?q=${encodeURIComponent(query)}`,
        METADATA_TIMEOUT_MS,
        fetchImpl
      ),

    youtubeRadio: (videoId: string) =>
      request(
        config,
        `/v1/radio?id=${encodeURIComponent(videoId)}`,
        METADATA_TIMEOUT_MS,
        fetchImpl
      ),

  };
}

/** Собранный один раз мост телефона: адрес и токен за время работы не меняются. */
let mobileBridge: StreamBridge | null | undefined;

/**
 * Мост для добычи звука и метаданных, независимо от того, где мы запущены.
 *
 * `null` означает «этим путём не выйдет» и разбирается вызывающим: `youtube.ts`
 * на это идёт своим запросом в InnerTube, который в вебе иногда срабатывает.
 */
export function getStreamBridge(): StreamBridge | null {
  if (typeof window === 'undefined') return null;

  const platform = detectPlatform(window);
  if (platform === 'electron') {
    return ((window as unknown as { electronAPI?: StreamBridge }).electronAPI) ?? null;
  }
  if (platform !== 'mobile') return null;

  if (mobileBridge === undefined) {
    const config = resolveServerConfig();
    if (!config) {
      // Не отказ: звук телефон добывает сам, сервер нужен радио и поиску.
      // Отдать здесь null значило бы отнять заодно и воспроизведение.
      console.warn(
        `[nativeBridge] Мобильная сборка без адреса сервера: задайте ${SERVER_URL_ENV} и ` +
          `${SERVER_TOKEN_ENV} перед сборкой. Музыка играть будет, радио и поиск — нет.`
      );
      mobileBridge = onDeviceResolve();
    } else {
      mobileBridge = createServerBridge(config);
    }
  }
  return mobileBridge;
}

/** Сброс запомненного моста. Нужен тестам: настройки читаются один раз. */
export function resetStreamBridge(): void {
  mobileBridge = undefined;
}
