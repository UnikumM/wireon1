import { UnifiedTrack } from '../types/music';
import { youtubeService, YouTubeService } from './youtube';
import { soundCloudService, SoundCloudService } from './soundcloud';
import { detectVariants, normalizeForMatch, rankCandidates } from './trackMatching';
import { db, getSetting, setSetting } from './db';
import { findLink, forgetLink, rememberLink } from './matchLinks';
import { detectPlatform } from './nativeBridge';
import { objectUrlFor, trackFileUrl } from './offlineFiles';
import { needsLocalSource } from './audioProcessing';
import { cacheStreamToFile } from './streamCache';

export interface ResolvedStreamInfo {
  streamUrl: string;
  format: string;
  bitrate: number;
  expiresAt: number;
  cached: boolean;
  /** SoundCloud only offered a snipped preview; the audio is not the full track. */
  isPreview?: boolean;
  /** Set when the audio came from another source than the track's own. */
  substitutedFrom?: 'youtube' | 'soundcloud';
}

interface CachedStream {
  streamUrl: string;
  format: string;
  bitrate: number;
  expiresAt: number;
  isPreview?: boolean;
  substitutedFrom?: 'youtube' | 'soundcloud';
}

/** Treat a stream as stale this long before its real expiry. */
const EXPIRY_MARGIN_MS = 30000;

/** A prefetch is worthwhile only if the cached URL is about to run out. */
const PREFETCH_MARGIN_MS = 60000;

/** After a failed prefetch, wait this long before trying that track again. */
const PREFETCH_COOLDOWN_MS = 30000;

/**
 * Насколько длительность замены может отличаться от оригинала, в секундах.
 *
 * Было 20 — и не проверялось вовсе: число стояло только в комментарии, а
 * длительность влияла лишь на баллы. Поэтому «Hot Together» (254 с) заменялась
 * переделкой на 270 с. Одна и та же запись у разных источников расходится на
 * пару секунд (на переносе 180 строк: 176 совпали с точностью до 3 с), а
 * другая редакция — на десятки. Восьми хватает с запасом на первое.
 */
const SUBSTITUTE_DURATION_TOLERANCE_S = 8;

/**
 * Насколько уверенным должно быть совпадение, чтобы играть замену.
 *
 * Строже, чем при импорте (там 55): импорт человек просматривает и правит
 * руками, а подмена случается сама во время воспроизведения. Цена ошибки разная:
 * там неверная строка в списке, здесь — чужая песня вместо той, что попросили.
 */
const SUBSTITUTE_MIN_SCORE = 85;

/**
 * Сколько ждём ответа источника, прежде чем считать попытку зависшей.
 *
 * Извлекатель в главном процессе перебирает несколько конфигураций клиента и на
 * каждой может молча ждать своей доли минут: там ограничено время простоя
 * сокета, а не всей попытки, и убить уже запущенный процесс нельзя. Без верхней
 * границы плеер остаётся на `await resolve()` в состоянии загрузки — отказа нет,
 * значит не будет ни подмены через SoundCloud, ни повторной попытки, ни ошибки
 * на экране. Предел превращает зависание в обычный отказ, который выше по стеку
 * уже умеют разбирать.
 */
export const SOURCE_TIMEOUT_MS = 30000;

/**
 * На телефоне тот же предел втрое больше, и это не щедрость, а замер.
 *
 * Ссылку там добывает сам телефон: поднимается Python, перебираются клиенты
 * YouTube, каждая полученная ссылка проверяется запросом к раздаче. На быстрой
 * сети это шесть секунд, на мобильной — десятки, а при неудачной первой ступени
 * ещё столько же на вторую. Тридцати секунд не хватало ровно в тех случаях,
 * ради которых перебор и заведён: попытка обрывалась по сроку, человек видел
 * ошибку — и через минуту тот же трек играл, потому что брошенная попытка всё
 * же дошла до кэша. Отсюда «иногда ошибка, а потом само».
 */
export const SOURCE_TIMEOUT_MOBILE_MS = 90000;

/** На подмену времени меньше: человек к этому моменту ждёт уже вдвое дольше обычного. */
export const SUBSTITUTE_TIMEOUT_MS = 15000;

/** Срок годности записи о файле в кэше: сам файл не протухает, но вытесняется. */
export const LOCAL_SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Фора YouTube перед тем, как за ту же песню возьмётся SoundCloud.
 *
 * Три секунды — это чуть больше, чем разбор из кэша (там доли секунды) и
 * заметно меньше, чем разбор с нуля (девять и выше). То есть привычный случай
 * «включил то, что уже слушал» до гонки не доходит вовсе, а долгое ожидание
 * прерывается.
 */
export const SUBSTITUTE_HEAD_START_MS = 3000;

/**
 * На телефоне фора длиннее, иначе YouTube не выигрывает никогда.
 *
 * Там разбор идёт на самом устройстве и занимает секунды даже в лучшем случае,
 * а поиск по SoundCloud — один обычный запрос. При форе в три секунды подмена
 * побеждала почти на каждом треке: человек выбирал запись на YouTube, а слушал
 * чужую загрузку с SoundCloud — иногда обрезанную, иногда вовсе не ту. Двенадцать
 * секунд покрывают обычный разбор целиком, и подмена снова становится тем, чем
 * задумана: спасением, а не правилом.
 */
export const SUBSTITUTE_HEAD_START_MOBILE_MS = 12000;

/** Предел ожидания источника здесь и сейчас: телефон и десктоп ждут по-разному. */
function sourceTimeoutMs(): number {
  return detectPlatform() === 'mobile' ? SOURCE_TIMEOUT_MOBILE_MS : SOURCE_TIMEOUT_MS;
}

/** Фора YouTube здесь и сейчас. См. {@link SUBSTITUTE_HEAD_START_MOBILE_MS}. */
function substituteHeadStartMs(): number {
  return detectPlatform() === 'mobile' ? SUBSTITUTE_HEAD_START_MOBILE_MS : SUBSTITUTE_HEAD_START_MS;
}

/** По этому тексту выше видно, что источник промолчал, а не отказал. */
export const RESOLVE_TIMEOUT_MESSAGE = 'Source did not answer in time';

/**
 * Ограничивает ожидание, не трогая саму работу.
 *
 * Брошенный запрос продолжает жить: остановить процесс в главном процессе мы
 * всё равно не можем, зато его результат ещё успеет лечь в кэш к следующей
 * попытке. Отдельный `catch` на исходном промисе нужен, чтобы опоздавший отказ
 * не всплыл как необработанный.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${RESOLVE_TIMEOUT_MESSAGE}: ${label}`)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, limit]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Кто ждёт ссылку. `prefetch` — фон: главный процесс держит для таких запросов
 * узкий лимит процессов извлекателя, чтобы нажатие play не стояло за ними.
 */
export type ResolvePriority = 'user' | 'prefetch';

/** Где на диске лежат разобранные ссылки, пережившие перезапуск. */
export const STREAM_CACHE_KEY = 'streamResolver.cache';

/** Пачка разборов подряд стоит одну запись на диск, а не десять. */
const STREAM_CACHE_WRITE_DELAY_MS = 2000;

export class StreamResolver {
  private ytService: YouTubeService;
  private scService: SoundCloudService;
  private cache: Map<string, CachedStream> = new Map();
  private inFlightResolutions: Map<string, Promise<ResolvedStreamInfo>> = new Map();
  /** С каким приоритетом ушёл запрос, который сейчас в работе. */
  private inFlightPriority: Map<string, ResolvePriority> = new Map();
  private failedPrefetches: Map<string, number> = new Map();
  private maxCacheSize: number = 200;
  /** Запись кэша на диск идёт с задержкой: подряд идущие разборы — одна запись. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    ytService?: YouTubeService,
    scService?: SoundCloudService,
    _cacheTtlMs?: number
  ) {
    this.ytService = ytService || youtubeService;
    this.scService = scService || soundCloudService;
  }

  /**
   * Возвращает разобранные ссылки, пережившие перезапуск.
   *
   * Ради чего. Разбор одного трека на телефоне занимает секунды — на эмуляторе
   * замерено 35 с, на настольной машине 9,5 с даже с быстрым интернетом. Ускорить
   * сам разбор нечем: клиенты YouTube, которые отвечают быстрее, отдают форматы,
   * которые `<audio>` не играет (проверено на четырёх). Зато сама ссылка живёт
   * около шести часов — и всё это время повторное включение того же трека могло
   * бы быть мгновенным. Кэш жил только в памяти, поэтому каждый запуск
   * приложения начинался с нуля: включил вечером то же, что слушал днём, и снова
   * ждёшь.
   *
   * Просроченные записи отбрасываются при чтении: хранить их незачем, а отдать
   * протухшую ссылку хуже, чем разобрать заново.
   */
  public async hydrateCache(): Promise<void> {
    try {
      const stored = await getSetting<Record<string, CachedStream>>(STREAM_CACHE_KEY, {});
      if (!stored || typeof stored !== 'object') return;
      const now = Date.now();
      for (const [id, entry] of Object.entries(stored)) {
        if (!entry?.streamUrl || typeof entry.expiresAt !== 'number') continue;
        if (entry.expiresAt <= now) continue;
        // Ссылки на офлайн-копии живут в памяти одного запуска: `blob:` адрес
        // после перезапуска не значит ничего.
        if (entry.streamUrl.startsWith('blob:')) continue;
        this.cache.set(id, entry);
      }
    } catch (err) {
      // Кэш — ускорение, а не условие работы: без него всё просто медленнее.
      console.warn('[StreamResolver] кэш ссылок не восстановился:', err);
    }
  }

  /** Откладывает запись на диск, чтобы пачка разборов стоила одну запись. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistCache();
    }, STREAM_CACHE_WRITE_DELAY_MS);
  }

  private async persistCache(): Promise<void> {
    try {
      this.purgeExpired();
      const out: Record<string, CachedStream> = {};
      for (const [id, entry] of this.cache) {
        if (entry.streamUrl.startsWith('blob:')) continue;
        out[id] = entry;
      }
      await setSetting(STREAM_CACHE_KEY, out);
    } catch (err) {
      console.warn('[StreamResolver] кэш ссылок не сохранился:', err);
    }
  }

  /**
   * Purges expired entries from in-memory cache
   */
  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(id);
      }
    }
  }

  /**
   * Reads a live cache entry, refreshing its LRU position.
   */
  private readCache(trackId: string): CachedStream | null {
    const entry = this.cache.get(trackId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now() + EXPIRY_MARGIN_MS) return null;

    this.cache.delete(trackId);
    this.cache.set(trackId, entry);
    return entry;
  }

  /**
   * Resolves a direct audio stream URL for any UnifiedTrack (YouTube or SoundCloud).
   * Intercepts and returns local blob Object URL immediately if track is stored offline.
   *
   * @param priority `prefetch` — фоновая задача: предзагрузка следующего трека
   *   или сохранение в офлайн. Такой запрос уступает место любому, которого
   *   ждёт человек.
   */
  public async resolve(
    track: UnifiedTrack,
    forceRefresh: boolean = false,
    priority: ResolvePriority = 'user',
    rejectUrl?: string
  ): Promise<ResolvedStreamInfo> {
    if (!track || !track.id) {
      throw new Error('Invalid track provided to StreamResolver');
    }

    // 1. Check if track is available in offline storage
    try {
      if (db && db.offlineTracks) {
        const offlineRecord = await db.offlineTracks.get(track.id);
        // Две формы хранения: файл на телефоне и `Blob` в базе на десктопе (а
        // на телефоне — у записей, скачанных до перехода на файлы).
        const fileUrl = offlineRecord?.filePath
          ? await trackFileUrl(offlineRecord.filePath)
          : null;
        const streamUrl =
          fileUrl ||
          (offlineRecord?.blob ? objectUrlFor(track.id, offlineRecord.blob) : null);
        if (streamUrl) {
          return {
            streamUrl,
            format: track.format || 'mp3',
            bitrate: track.bitrate || 320,
            expiresAt: Date.now() + 24 * 3600 * 1000,
            cached: true
          };
        }
      }
    } catch (err) {
      console.warn('[StreamResolver] Offline track check error:', err);
    }

    if (!forceRefresh) {
      const cached = this.readCache(track.id);
      if (cached) {
        return { ...cached, cached: true };
      }
    }

    // Check if this track is already actively being resolved to prevent duplicate network calls
    const inFlight = this.inFlightResolutions.get(track.id);
    if (inFlight) {
      // Человек нажал play на том, что качается в фоне. Второй раз запрашивать
      // нечего, а вот приоритет в главном процессе поднять надо: там заявка
      // может ещё стоять в очереди за другими фоновыми.
      if (priority === 'user' && this.inFlightPriority.get(track.id) === 'prefetch') {
        this.inFlightPriority.set(track.id, 'user');
        this.raisePriority(track);
      }
      return inFlight;
    }

    const resolutionPromise = this.performResolution(track, priority, rejectUrl).finally(() => {
      this.inFlightResolutions.delete(track.id);
      this.inFlightPriority.delete(track.id);
    });

    // The map holds the same promise every caller awaits, so a rejection is
    // always observed by at least the caller that started the resolution.
    this.inFlightResolutions.set(track.id, resolutionPromise);
    this.inFlightPriority.set(track.id, priority);
    return resolutionPromise;
  }

  /**
   * Просит главный процесс поднять приоритет уже идущего запроса.
   *
   * Только для YouTube: у SoundCloud ссылка берётся одним обычным запросом, без
   * очереди процессов, поэтому и обгонять там нечего.
   */
  private raisePriority(track: UnifiedTrack): void {
    if (track.source !== 'youtube' || !track.originalId) return;
    if (typeof this.ytService.raiseStreamPriority !== 'function') return;
    try {
      this.ytService.raiseStreamPriority(track.originalId);
    } catch (err) {
      console.warn('[StreamResolver] Could not raise stream priority:', err);
    }
  }

  /**
   * Internal resolution router
   */
  private async performResolution(
    track: UnifiedTrack,
    priority: ResolvePriority = 'user',
    rejectUrl?: string
  ): Promise<ResolvedStreamInfo> {
    let result: CachedStream;

    if (track.source === 'youtube') {
      const youtube = withTimeout(
        this.ytService.resolveStreamUrl(track.originalId, priority, rejectUrl),
        sourceTimeoutMs(),
        `youtube ${track.originalId}`
      );

      try {
        result = await this.raceWithSoundCloud(track, youtube, priority);
      } catch (err) {
        // YouTube blocks individual videos far more often than SoundCloud blocks
        // whole songs, so a refusal here is worth one lookup elsewhere before the
        // queue stalls on a track the user can plainly hear on another service.
        // Молчание источника разбираем так же, как отказ: причина для человека
        // одна и та же — эта песня отсюда сейчас не играет.
        const substitute = await this.resolveViaSoundCloud(track);
        if (substitute) {
          console.warn(
            `[StreamResolver] YouTube refused "${track.title}" — playing the SoundCloud version instead`
          );
          result = substitute;
        } else {
          throw err;
        }
      }
    } else if (track.source === 'soundcloud') {
      // Есть ли куда уйти, если SoundCloud откажет. Знать это нужно заранее:
      // при подтверждённом запасном источнике SoundCloud не тратит время на
      // проверку своей приметы про загрузки лейблов.
      const fallbackKnown = (await findLink(track).catch(() => null))?.source === 'youtube';
      try {
        result = await withTimeout(
          this.scService.resolveStreamUrl(track.originalId, undefined, undefined, {
            preferKnownFallback: fallbackKnown
          }),
          sourceTimeoutMs(),
          `soundcloud ${track.originalId}`
        );
        // Тридцатисекундный отрывок — это не трек. Раньше он доезжал до
        // человека как «воспроизведение», обрываясь на середине куплета.
        if (result?.isPreview) {
          const full = await this.resolveViaYouTube(track);
          if (full) {
            console.info(`[StreamResolver] SoundCloud отдал отрывок "${track.title}" — играет версия с YouTube`);
            result = full;
          }
        }
      } catch (err) {
        // Причины отказа разные — защищённая загрузка, ни одного пригодного
        // потока, протухший ключ, — а для человека все они означают одно: эта
        // песня отсюда сейчас не играет. Значит и разбираются одинаково: ищем
        // ту же запись на YouTube и молчим, если нашли.
        const substitute = await this.resolveViaYouTube(track);
        if (!substitute) throw err;
        console.warn(`[StreamResolver] SoundCloud отказал в "${track.title}" — играет версия с YouTube`);
        result = substitute;
      }
    } else {
      throw new Error(`Unsupported audio source: ${track.source}`);
    }

    if (!result || !result.streamUrl) {
      throw new Error(`Stream resolution returned no URL for ${track.id}`);
    }

    /*
     * Телефон с включённой обработкой звука играет файл, а не ссылку.
     *
     * Через Web Audio проходит только «чистый» источник, а прямой поток
     * googlevideo без заголовков CORS считается запятнанным и даёт тишину
     * (`audioProcessing.ts`). Поэтому трек кладётся в кэш целиком и играет
     * оттуда. Не получилось — играем ссылку, как раньше: звук важнее эффектов.
     *
     * HLS так не забрать: по ссылке лежит список кусков, а не звук.
     */
    if (needsLocalSource() && detectPlatform() === 'mobile' && result.format !== 'hls') {
      const local = await cacheStreamToFile(track.id, result.streamUrl);
      if (local) {
        // Файл не протухает вместе со ссылкой, но и вечным его считать нельзя:
        // кэш вытесняется по числу файлов.
        result = { ...result, streamUrl: local, expiresAt: Date.now() + LOCAL_SOURCE_TTL_MS };
      }
    }

    // Purge expired & enforce LRU size limit
    this.purgeExpired();
    while (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }

    // Cache the resolved stream
    this.cache.set(track.id, result);
    this.failedPrefetches.delete(track.id);
    this.schedulePersist();

    return {
      ...result,
      cached: false
    };
  }

  /**
   * Даёт YouTube фору, а потом пускает SoundCloud наперегонки.
   *
   * Зачем. Разбор ссылки YouTube на телефоне идёт секундами: замерено 35 с на
   * эмуляторе и 9,5 с на настольной машине даже с быстрым интернетом. Ускорить
   * его нечем — быстрые клиенты YouTube отдают форматы, которые `<audio>` не
   * играет, это проверено на четырёх. SoundCloud при этом отвечает почти сразу:
   * там ссылка отдаётся как есть, без расшифровки подписи и без запуска Python.
   *
   * Отсюда приём: сперва фора, чтобы YouTube успел ответить сам — тогда играет
   * ровно та запись, которую человек выбрал. Не успел за {@link SUBSTITUTE_HEAD_START_MS} —
   * параллельно ищется та же песня на SoundCloud, и играет то, что готово первым.
   * YouTube при этом не отменяется: если он ответит раньше подмены, победит он.
   *
   * Подмена проходит только строгую сверку (артист, название, длительность) —
   * ту же, что и при отказе YouTube. Лучше подождать, чем без спроса включить
   * кавер или часовой микс.
   *
   * Фоновые прогревы очереди в гонку не идут: там никто не ждёт, а лишний поиск
   * на каждый трек очереди — это трафик впустую.
   */
  private async raceWithSoundCloud(
    track: UnifiedTrack,
    youtube: Promise<CachedStream>,
    priority: ResolvePriority
  ): Promise<CachedStream> {
    if (priority !== 'user') return youtube;

    /*
     * Отказ YouTube не заглушается.
     *
     * Первая попытка глушила его в вечное ожидание, чтобы «дать подмене
     * договорить» — и получалось, что при неудаче обеих сторон не завершалось
     * ничего вовсе. Пусть отказ проходит: внешний `catch` его поймает и всё
     * равно сходит на SoundCloud, только уже без спешки.
     */
    const substitute = new Promise<CachedStream>((resolve) => {
      setTimeout(() => {
        this.resolveViaSoundCloud(track)
          .then((found) => {
            // Подмены нет — эта ветка молчит: объявлять проигрыш там, где
            // YouTube ещё в пути, значит отменить живую попытку.
            if (found) resolve(found);
          })
          .catch(() => {});
      }, substituteHeadStartMs());
    });

    const winner = await Promise.race([youtube, substitute]);
    if (winner.substitutedFrom === 'soundcloud') {
      console.info(
        `[StreamResolver] YouTube не ответил за ${SUBSTITUTE_HEAD_START_MS} мс — играет версия с SoundCloud: "${track.title}"`
      );
    }
    return winner;
  }

  /**
   * Подтверждённая замена, если она уже известна.
   *
   * Смысл: подбор по названию — догадка, и повторять её при каждом отказе
   * незачем. Один раз найденная и сыгравшая запись запоминается
   * (`matchLinks`), и дальше отказ источника стоит одного запроса за ссылкой
   * вместо поиска с перебором кандидатов.
   *
   * Что делать с неудачей, зависит от того, кто связь подтвердил. Выбранную
   * человеком оставляем: он сказал, какая запись верна, и разовое молчание
   * источника этого не отменяет. Найденную нами — снимаем: она была догадкой,
   * которая однажды сыграла, и если играть перестала, честнее поискать заново,
   * чем возвращаться к ней при каждом отказе.
   */
  private async resolveKnownLink(
    track: UnifiedTrack,
    want: 'youtube' | 'soundcloud'
  ): Promise<CachedStream | null> {
    try {
      const known = await findLink(track);
      if (!known || known.source !== want || !known.originalId) return null;

      const resolved =
        want === 'youtube'
          ? await withTimeout(
              this.ytService.resolveStreamUrl(known.originalId),
              sourceTimeoutMs(),
              `youtube link ${known.originalId}`
            )
          : await withTimeout(
              this.scService.resolveStreamUrl(known.originalId),
              SUBSTITUTE_TIMEOUT_MS,
              `soundcloud link ${known.originalId}`
            );

      if (!resolved || !resolved.streamUrl) {
        await this.dropAutomaticLink(track);
        return null;
      }
      // Отрывок вместо трека — не ответ, даже подтверждённый. Поле есть только
      // у SoundCloud: у YouTube обрезанных потоков не бывает.
      if ((resolved as { isPreview?: boolean }).isPreview) {
        await this.dropAutomaticLink(track);
        return null;
      }

      console.info(`[StreamResolver] Подтверждённая замена: "${known.title}" — ${known.artist}`);
      return { ...resolved, substitutedFrom: want };
    } catch (err) {
      console.warn('[StreamResolver] подтверждённая связь не сыграла:', err);
      await this.dropAutomaticLink(track);
      return null;
    }
  }

  /** Снимает связь, если её подтвердили не руками. Ручную не трогает. */
  private async dropAutomaticLink(track: UnifiedTrack): Promise<void> {
    try {
      const known = await findLink(track);
      if (known && !known.manual) await forgetLink(track);
    } catch (err) {
      console.warn('[StreamResolver] связь снять не удалось:', err);
    }
  }

  /**
   * Finds the same song on SoundCloud and resolves that instead.
   *
   * Only accepts a candidate whose artist and title both match and whose length
   * is within {@link SUBSTITUTE_DURATION_TOLERANCE_S} — otherwise a blocked track
   * would silently play a remix, a cover, or an hour-long mix.
   *
   * @returns the substitute stream, or null when nothing close enough exists
   */
  private async resolveViaSoundCloud(track: UnifiedTrack): Promise<CachedStream | null> {
    const known = await this.resolveKnownLink(track, 'soundcloud');
    if (known) return known;

    try {
      const query = `${track.artist || ''} ${track.title || ''}`.trim();
      if (query.length < 3) return null;

      // Оба ожидания ограничены: подмена — это уже вторая попытка, и если она
      // затянется, ждать станет дольше, чем если бы её не было вовсе.
      // Собственный `catch` ниже превратит истёкший срок в честный null.
      const candidates = await withTimeout(
        this.scService.search(query, 8),
        SUBSTITUTE_TIMEOUT_MS,
        `soundcloud search "${query}"`
      );
      if (!Array.isArray(candidates) || candidates.length === 0) return null;

      const match = this.pickSameRecording(track, candidates);
      if (!match) return null;

      console.info(
        `[StreamResolver] Подмена с SoundCloud: "${match.title}" — ${match.artist}`
      );

      const resolved = await withTimeout(
        this.scService.resolveStreamUrl(match.originalId),
        SUBSTITUTE_TIMEOUT_MS,
        `soundcloud substitute ${match.originalId}`
      );
      if (!resolved || !resolved.streamUrl) return null;
      // A 30-second preview is worse than an honest error message.
      if (resolved.isPreview) return null;

      // Сыграло — значит для этой записи запасной источник известен. Пишем
      // до возврата, а не вдогонку: запись крошечная, а незавершённая запись
      // в фоне означала бы, что следующий отказ может ещё не знать ответа.
      await rememberLink(track, match);

      return { ...resolved, substitutedFrom: 'soundcloud' };
    } catch (err) {
      console.warn('[StreamResolver] SoundCloud substitution failed:', err);
      return null;
    }
  }

  /**
   * Из чужих результатов поиска выбирает ту же самую запись — или ничего.
   *
   * Общий отбор для обеих замен: с YouTube на SoundCloud и обратно. Правил три,
   * и каждое появилось из настоящей подмены не той песни:
   *
   *   • все значимые слова названия обязаны найтись у кандидата. Оценка сама по
   *     себе этого не требует — она считает долю общего, и короткое «Numb»
   *     целиком содержится в «Numb / Encore», то есть выглядит идеальным
   *     совпадением, оставаясь другой песней;
   *   • пометки вроде «sped up», «cover» и «live» допустимы, только если о них
   *     просили в самом запросе: замена обязана быть той же записью, а не той
   *     же песней в чужом исполнении;
   *   • порог совпадения строже импортного. Импорт человек просматривает
   *     глазами, а замена случается сама во время воспроизведения.
   */
  private pickSameRecording(
    track: UnifiedTrack,
    candidates: ReadonlyArray<UnifiedTrack>
  ): UnifiedTrack | null {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const wantedVariants = new Set(detectVariants(`${track.title} ${track.artist || ''}`));
    const wantedWords = normalizeForMatch(track.title)
      .split(' ')
      .filter((word) => word.length >= 3);

    /*
     * Оцениваем всех, отбираем после — по той же причине, что и при переносе.
     *
     * Штраф за чужого исполнителя относительный и считается по всему набору
     * кандидатов. Если сначала отфильтровать, а потом оценивать, отсев
     * правильной записи заодно снимает штраф со всех остальных — и чужая песня
     * с похожим названием получает проходной балл.
     */
    const fits = (candidate: UnifiedTrack): boolean => {
      const haystack = normalizeForMatch(`${candidate.title || ''} ${candidate.artist || ''}`);
      const titleCovered = wantedWords.every((word) => haystack.includes(word));
      const sameVariant = detectVariants(`${candidate.title || ''} ${candidate.artist || ''}`).every((marker) =>
        wantedVariants.has(marker)
      );
      // Длительность — жёсткое условие, а не только баллы: замена случается сама,
      // и другая редакция той же песни здесь хуже честной ошибки.
      const sameLength =
        !(track.duration > 0 && candidate.duration > 0) ||
        Math.abs(candidate.duration - track.duration) <= SUBSTITUTE_DURATION_TOLERANCE_S;
      return titleCovered && sameVariant && sameLength;
    };

    const ranked = rankCandidates(
      { title: track.title, artist: track.artist, duration: track.duration },
      candidates
    );
    const best = ranked.find(
      (entry) => entry.score >= SUBSTITUTE_MIN_SCORE && fits(entry.candidate)
    );
    return best ? best.candidate : null;
  }

  /**
   * Находит ту же песню на YouTube и играет её вместо трека SoundCloud.
   *
   * Зеркало {@link resolveViaSoundCloud}, и появилось по той же причине, только
   * с другой стороны. SoundCloud отказывает не реже: часть загрузок лейблы
   * публикуют только в защищённом виде, у части нет ни одного пригодного
   * потока, а ключ доступа протухает сам по себе. До сих пор любой такой отказ
   * доезжал до человека красной надписью — хотя ту же песню мы умеем играть с
   * YouTube.
   *
   * @returns поток замены или null, если ничего достаточно близкого нет
   */
  private async resolveViaYouTube(track: UnifiedTrack): Promise<CachedStream | null> {
    const known = await this.resolveKnownLink(track, 'youtube');
    if (known) return known;

    try {
      const query = `${track.artist || ''} ${track.title || ''}`.trim();
      if (query.length < 3) return null;

      const candidates = await withTimeout(
        this.ytService.search(query, 8),
        SUBSTITUTE_TIMEOUT_MS,
        `youtube search "${query}"`
      );

      let match = this.pickSameRecording(track, candidates);
      if (!match && typeof this.ytService.searchVideos === 'function') {
        // Песни нет — есть клип или чужая загрузка. Отбор тот же, строгий:
        // «slowed» вместо обычной версии он не пропустит.
        const videos = await withTimeout(
          this.ytService.searchVideos(query, 8),
          SUBSTITUTE_TIMEOUT_MS,
          `youtube video search "${query}"`
        ).catch(() => [] as UnifiedTrack[]);
        match = this.pickSameRecording(track, videos);
      }
      if (!match) return null;

      console.info(`[StreamResolver] Подмена с YouTube: "${match.title}" — ${match.artist}`);

      /*
       * Срок — как у обычного включения с YouTube, а не короткий срок замены.
       * Замерено на «XXL» (5opka): первая конфигурация получила 403, ссылка
       * пришла с четвёртой через 16,2 с — а замена сдавалась на пятнадцатой и
       * показывала ошибку. Это последний шанс трека сыграть, спешить некуда.
       */
      const resolved = await withTimeout(
        this.ytService.resolveStreamUrl(match.originalId),
        sourceTimeoutMs(),
        `youtube substitute ${match.originalId}`
      );
      if (!resolved || !resolved.streamUrl) return null;

      // Сыграло — значит для этой записи запасной источник известен. Пишем
      // до возврата, а не вдогонку: запись крошечная, а незавершённая запись
      // в фоне означала бы, что следующий отказ может ещё не знать ответа.
      await rememberLink(track, match);

      return { ...resolved, substitutedFrom: 'youtube' };
    } catch (err) {
      console.warn('[StreamResolver] YouTube substitution failed:', err);
      return null;
    }
  }

  /**
   * Pre-warms the stream URL for an upcoming track. Safe to call on every queue
   * change: concurrent calls share the in-flight resolution, a still-valid cache
   * entry is a no-op, a recent failure is not retried immediately, and the
   * rejection is always handled.
   */
  public prefetch(track: UnifiedTrack): void {
    if (!track || !track.id) return;

    const cached = this.cache.get(track.id);
    if (cached && cached.expiresAt > Date.now() + PREFETCH_MARGIN_MS) return;

    if (this.inFlightResolutions.has(track.id)) return;

    const lastFailure = this.failedPrefetches.get(track.id);
    if (lastFailure !== undefined && Date.now() - lastFailure < PREFETCH_COOLDOWN_MS) return;

    void this.resolve(track, false, 'prefetch').catch(err => {
      this.failedPrefetches.set(track.id, Date.now());
      console.warn(`[StreamResolver] Prefetch failed for ${track.title || track.id}:`, err);
    });
  }

  /**
   * Clears the stream resolution cache
   */
  public clearCache(): void {
    this.cache.clear();
    this.failedPrefetches.clear();
  }

  /**
   * Removes a single track from cache
   */
  public invalidate(trackId: string): void {
    this.cache.delete(trackId);
    this.failedPrefetches.delete(trackId);
  }
}

export const streamResolver = new StreamResolver();
