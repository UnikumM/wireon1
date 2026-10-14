/**
 * Добыча ссылки на аудио **самим телефоном**.
 *
 * Почему не сервером — это главное, что надо знать про этот файл. Замерено
 * 2026-08-28 на живом контейнере, двумя точками обзора:
 *
 * - без cookies сервер получает от YouTube проверку «вы не робот» на каждый
 *   трек: у него адрес дата-центра, один на всех слушателей;
 * - с cookies проверка уходит, но выданная ссылка содержит `ip=<адрес сервера>`
 *   и подписана вместе с ним — с любого другого адреса это 403.
 *
 * То есть «сервер отдаёт только ссылку, телефон качает сам» не работает не
 * из-за недоделки, а по устройству YouTube. У телефона же адрес домашний:
 * проверки нет, и ссылка выписывается на него же. Заодно из горячего пути
 * уходит и yt-dlp, и чужой аккаунт, чьи cookies надо обновлять руками.
 *
 * Разбор — один запрос /player от имени клиента `visionos` (см. ниже, почему
 * не `youtubei.js`): готовая ссылка без расшифровки и без PO-токена.
 */

import { getStreamExpiryFromUrl } from './youtube';

/** Ответ в той же форме, что отдаёт главный процесс на десктопе. */
export interface OnDeviceStream {
  streamUrl: string;
  format: string;
  bitrate: number;
  expiresAt: number;
}

/**
 * Состояния плеера YouTube, переведённые в те же коды, что уже умеет
 * `playbackErrors.ts`. Свои коды здесь означали бы «что-то пошло не так»
 * вместо совета, который человек может выполнить.
 */
const STATUS_CODES: Record<string, string> = {
  LOGIN_REQUIRED: 'YT_AGE_RESTRICTED',
  AGE_VERIFICATION_REQUIRED: 'YT_AGE_RESTRICTED',
  CONTENT_CHECK_REQUIRED: 'YT_AGE_RESTRICTED',
  UNPLAYABLE: 'YT_UNAVAILABLE',
  ERROR: 'YT_UNAVAILABLE',
  LIVE_STREAM_OFFLINE: 'YT_LIVE'
};

/** Ошибка в форме `КОД: подробности` — её ждёт `describePlaybackError`. */
export class OnDeviceError extends Error {
  public readonly code: string;

  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'OnDeviceError';
    this.code = code;
  }
}

/**
 * Клиент InnerTube. Один на всё время работы: его создание тянет с YouTube
 * главную ради visitorData — лишний запрос, который незачем повторять на
 * каждый трек.
 */
type Innertube = {
  getBasicInfo: (videoId: string, client?: string) => Promise<any>;
  session: { player?: unknown };
};

let clientPromise: Promise<Innertube> | null = null;

/**
 * Как создаётся клиент. Вынесено отдельно, чтобы тесты подставляли свой
 * вариант: настоящий лезет в сеть, а проверять надо разбор и коды отказов.
 */
type ClientFactory = () => Promise<Innertube>;

/**
 * Клиент `visionos` — тот же, что выбирает yt-dlp на десктопе.
 *
 * Замерено 2026-10-14 на 30 треках с домашнего адреса: `youtubei.js` 18 у
 * клиентов ANDROID/WEB отдаёт только SABR, а у YTMUSIC/IOS — ссылку, которая без
 * PO-токена обрывается 403 после первого мегабайта (то есть трек играет минуту).
 * `visionos` отдаёт готовые ссылки (`REQUIRE_JS_PLAYER: False` в yt-dlp), и все
 * 30 скачались целиком, без токенов и расшифровки. Обязательное условие —
 * visitorData с главной: без него тот же запрос получает «вы не робот».
 * Значения — из `yt_dlp/extractor/youtube/_base.py`; сломается — сверить там.
 */
const VISIONOS_CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
  gl: 'US'
};
const VISIONOS_CLIENT_ID = '101';

/** Ответ /player в той форме, которую разбирает {@link resolveOnDevice}. */
function toBasicInfo(player: any): any {
  const formats = (player?.streamingData?.adaptiveFormats || []).map((f: any) => {
    const mime = String(f?.mimeType || '');
    return {
      has_audio: mime.startsWith('audio/'),
      has_video: mime.startsWith('video/'),
      bitrate: f?.bitrate,
      mime_type: mime,
      url: f?.url
    };
  });
  return {
    playability_status: {
      status: player?.playabilityStatus?.status,
      reason: player?.playabilityStatus?.reason
    },
    streaming_data: { adaptive_formats: formats, formats: [] }
  };
}

const visionosFactory: ClientFactory = async () => {
  const page = await fetch('https://www.youtube.com/', {
    headers: { 'User-Agent': VISIONOS_CLIENT.userAgent, 'Accept-Language': 'en-US,en;q=0.9' }
  });
  const visitorData = (await page.text()).match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
  // Без visitorData YouTube отвечает «вы не робот» на всё: лучше честно упасть
  // здесь — неудачный старт не запоминается, и следующий трек попробует снова.
  if (!visitorData) throw new Error('на главной YouTube нет VISITOR_DATA');

  return {
    session: {},
    getBasicInfo: async (videoId: string) => {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': VISIONOS_CLIENT.userAgent,
          'X-YouTube-Client-Name': VISIONOS_CLIENT_ID,
          'X-YouTube-Client-Version': VISIONOS_CLIENT.clientVersion,
          'X-Goog-Visitor-Id': visitorData,
          Origin: 'https://www.youtube.com'
        },
        body: JSON.stringify({
          context: { client: { ...VISIONOS_CLIENT, visitorData } },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true
        })
      });
      if (!response.ok) throw new Error(`YouTube /player ответил ${response.status}`);
      return toBasicInfo(await response.json());
    }
  };
};

let factory: ClientFactory = visionosFactory;

/** Подменяет создание клиента; `null` возвращает настоящий. Только для тестов. */
export function setInnertubeFactory(next: ClientFactory | null): void {
  factory = next ?? visionosFactory;
  clientPromise = null;
}

/** Сбрасывает клиент — тестам и на случай, когда файл плеера протух. */
export function resetInnertube(): void {
  clientPromise = null;
}

async function client(): Promise<Innertube> {
  if (!clientPromise) {
    clientPromise = factory().catch((err) => {
      // Не запоминаем неудачу: сеть на телефоне пропадает и возвращается, и
      // один отказ при старте не должен означать «музыки не будет до
      // перезапуска приложения».
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

function toPositive(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Выбирает дорожку без картинки и с наибольшим битрейтом.
 *
 * Своим перебором, а не `chooseFormat`: тот умеет отдать дорожку с видео, если
 * чистого аудио не нашёл, — на телефоне это трафик за кадры, которых никто не
 * видит. Здесь отсутствие аудио честно означает отказ.
 */
export function pickAudio(formats: any[]): any | null {
  const audio = (formats || []).filter(
    (f) => f && f.has_audio !== false && f.has_video !== true && (f.url || f.signature_cipher || f.cipher)
  );
  if (!audio.length) return null;
  return audio.reduce((best, f) => (toPositive(f.bitrate) > toPositive(best.bitrate) ? f : best));
}

/** Расширение по типу дорожки: `audio/mp4; codecs="mp4a.40.2"` → `m4a`. */
export function extensionOf(mimeType: unknown): string {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  return 'm4a';
}

/**
 * Ссылка на аудио для одного видео.
 *
 * Клиент `ANDROID` не для маскировки под приложение: он отдаёт ссылки, которым
 * не нужна расшифровка подписи, и это заметно короче путь, чем разбирать файл
 * плеера на каждый трек.
 */
export async function resolveOnDevice(videoId: string): Promise<OnDeviceStream> {
  if (!videoId) throw new OnDeviceError('YT_BAD_ID', 'videoId не задан');

  let info: any;
  try {
    const yt = await client();
    info = await yt.getBasicInfo(videoId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new OnDeviceError('YT_ALL_ATTEMPTS_FAILED', message);
  }

  const status = String(info?.playability_status?.status || '').toUpperCase();
  if (status && status !== 'OK') {
    const reason = String(info?.playability_status?.reason || status);
    // «Подтвердите, что вы не робот» — это не возраст: протух visitorData.
    // Сбрасываем клиента, чтобы следующий трек взял свежий.
    if (/not a bot/i.test(reason)) {
      resetInnertube();
      throw new OnDeviceError('YT_BOT_CHECK', reason);
    }
    throw new OnDeviceError(STATUS_CODES[status] || 'YT_UNAVAILABLE', reason);
  }

  const formats = [
    ...(info?.streaming_data?.adaptive_formats || []),
    ...(info?.streaming_data?.formats || [])
  ];
  const chosen = pickAudio(formats);
  if (!chosen) {
    throw new OnDeviceError('YT_NO_AUDIO', `в ответе нет звуковой дорожки для ${videoId}`);
  }

  let url: string | undefined = chosen.url;
  if (!url && typeof chosen.decipher === 'function') {
    try {
      const yt = await client();
      url = await chosen.decipher(yt.session.player);
    } catch (err) {
      throw new OnDeviceError(
        'YT_ALL_ATTEMPTS_FAILED',
        `подпись не расшифрована: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (!url) {
    throw new OnDeviceError('YT_NO_AUDIO', `у выбранной дорожки нет адреса (${videoId})`);
  }

  return {
    streamUrl: url,
    format: extensionOf(chosen.mime_type),
    // Битрейт приходит в битах в секунду, а вся остальная программа считает в
    // килобитах — на экране качества иначе будет «129000 кбит/с».
    bitrate: Math.round(toPositive(chosen.bitrate) / 1000) || 128,
    expiresAt: getStreamExpiryFromUrl(url)
  };
}
