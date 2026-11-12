/**
 * Обложка нужного размера из того же адреса.
 *
 * Источники отдают одну и ту же картинку в нескольких размерах, и размер зашит
 * в адрес. В медиатеке лежит мелкий вариант: списку из сотни строк крупнее не
 * нужно, и на телефоне это вчетверо меньше трафика. Но та же мелкая картинка
 * шла и на сцену плеера, где обложка занимает треть экрана, — там она мылилась.
 *
 * Здесь адрес переписывается под место: сколько пикселей займёт обложка, какая
 * плотность экрана и какая сеть. Запросов модуль не делает; какой вариант
 * реально существует, выясняет тот, кто грузит картинку, идя по списку
 * кандидатов от лучшего к гарантированному.
 */

/** Ступени размеров: под них и переписываются адреса. */
const SIZE_STEPS = [120, 240, 320, 500, 720, 1200] as const;

export interface NetworkHints {
  /** Плотность экрана. Выше двух не берём: разницу не видно, а трафик растёт. */
  dpr?: number;
  /** Человек включил экономию трафика. */
  saveData?: boolean;
  /** Оценка сети браузером: 'slow-2g' | '2g' | '3g' | '4g'. */
  effectiveType?: string;
}

/** Что известно о сети и экране прямо сейчас. Вне браузера — пусто. */
export function currentNetworkHints(): NetworkHints {
  if (typeof window === 'undefined') return {};
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return {
    dpr: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1,
    saveData: connection?.saveData === true,
    effectiveType: typeof connection?.effectiveType === 'string' ? connection.effectiveType : undefined
  };
}

/**
 * Сколько пикселей просить для обложки шириной `cssPx`.
 *
 * Медленная сеть и экономия трафика ограничивают размер сверху: чёткая обложка
 * не стоит того, чтобы трек ждал её дольше, чем начнёт играть.
 */
export function pickArtworkSize(cssPx: number, hints: NetworkHints = {}): number {
  const dpr = Math.min(Math.max(hints.dpr || 1, 1), 2);
  let cap: number = SIZE_STEPS[SIZE_STEPS.length - 1];
  if (hints.saveData || hints.effectiveType === 'slow-2g' || hints.effectiveType === '2g') cap = 320;
  else if (hints.effectiveType === '3g') cap = 500;

  const wanted = Math.max(1, cssPx) * dpr;
  const step = SIZE_STEPS.find((size) => size >= wanted) ?? SIZE_STEPS[SIZE_STEPS.length - 1];
  return Math.min(step, cap);
}

const YTIMG = /^(https?:\/\/i\d*\.ytimg\.com\/vi(?:_webp)?\/[\w-]{6,}\/)(?:default|mqdefault|hqdefault|sddefault|hq720|maxresdefault)(\.(?:jpg|webp))(\?.*)?$/i;

/** Размер в адресах Google: `=w120-h120-l90-rj` и `=s120-…`. */
const GOOGLE_WH = /=w\d+-h\d+/;
const GOOGLE_S = /=s\d+/;

const SOUNDCLOUD_SIZE = /-(?:large|small|badge|tiny|mini|crop|original|t\d+x\d+)(\.(?:jpg|jpeg|png|webp))(\?.*)?$/i;

function isGoogleImage(url: string): boolean {
  return /googleusercontent\.com|ggpht\.com/i.test(url);
}

/**
 * Варианты одной обложки под размер `targetPx`, от лучшего к гарантированному.
 *
 * Список, а не один адрес, из-за YouTube: крупные кадры (`maxresdefault`,
 * `hq720`) есть не у каждого видео. Вместо отсутствующего YouTube отдаёт серую
 * заглушку 120×90 — картинку, а не ошибку, — поэтому грузящий обязан проверить
 * её размер и перейти к следующему адресу. Последним всегда стоит исходный.
 *
 * `sddefault` и `hqdefault` в список не входят намеренно: это кадры 4:3 с
 * запечёнными чёрными полями (см. `getYouTubeArtworkUrl`).
 */
export function artworkCandidates(url: string | null | undefined, targetPx: number): string[] {
  const source = (url || '').trim();
  if (!source || !/^https?:\/\//i.test(source)) return source ? [source] : [];

  const out: string[] = [];
  const add = (candidate: string) => {
    if (!out.includes(candidate)) out.push(candidate);
  };

  const yt = YTIMG.exec(source);
  if (yt) {
    const [, base, ext, query = ''] = yt;
    if (targetPx > 320) {
      // Оба 1280×720; у старых видео есть только один из них или ни одного.
      add(`${base}maxresdefault${ext}${query}`);
      add(`${base}hq720${ext}${query}`);
    }
    add(`${base}mqdefault${ext}${query}`);
    add(source);
    return out;
  }

  if (isGoogleImage(source)) {
    const px = Math.round(targetPx);
    if (GOOGLE_WH.test(source)) add(source.replace(GOOGLE_WH, `=w${px}-h${px}`));
    else if (GOOGLE_S.test(source)) add(source.replace(GOOGLE_S, `=s${px}`));
    add(source);
    return out;
  }

  if (/sndcdn\.com/i.test(source) && SOUNDCLOUD_SIZE.test(source)) {
    const size = targetPx > 300 ? 't500x500' : targetPx > 120 ? 't300x300' : 'large';
    add(source.replace(SOUNDCLOUD_SIZE, `-${size}$1$2`));
    add(source);
    return out;
  }

  return [source];
}

/** Лучший адрес под размер — когда проверять существование некому (система, MediaSession). */
export function artworkAt(url: string | null | undefined, targetPx: number): string {
  return artworkCandidates(url, targetPx)[0] ?? '';
}

/**
 * Адрес покрупнее, который точно существует, — для мест, где проверить картинку
 * некому: системное уведомление и MediaSession берут адрес как есть. У Google и
 * SoundCloud любой размер отдаётся всегда; у кадров YouTube крупный может
 * оказаться серой заглушкой, поэтому там остаётся исходный адрес.
 */
export function artworkGuaranteed(url: string | null | undefined, targetPx: number): string {
  const source = (url || '').trim();
  if (YTIMG.test(source)) return source;
  return artworkAt(source, targetPx);
}

/** Заглушка YouTube вместо отсутствующего кадра: 120×90. Настоящие кадры крупнее. */
export function isMissingFramePlaceholder(naturalWidth: number, naturalHeight: number): boolean {
  return naturalWidth > 0 && naturalWidth <= 120 && naturalHeight <= 90;
}
