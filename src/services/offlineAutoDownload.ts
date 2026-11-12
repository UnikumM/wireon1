/**
 * Офлайн 2.0: избранное скачивается само.
 *
 * Офлайн-режим (`offlineMode.ts`) сохраняет то, что уже слушают, — и ничего не
 * обещает про то, что человек отметил сердечком, но ещё не включал. Эта служба
 * закрывает ровно эту дыру: раз в избранном — значит, лежит на устройстве.
 *
 * Правила, которые здесь важны:
 * - качается по одному и с паузой: загрузка не должна спорить с плеером за
 *   канал, а на телефоне — греть его часами подряд;
 * - лимит места считается по всему офлайн-кэшу, и под него уходят сначала те
 *   копии, что дольше всех не включали и **не из избранного**. Избранное не
 *   трогаем: если место кончилось, а остались только любимые — останавливаемся
 *   и честно говорим об этом в настройках;
 * - на телефоне по умолчанию только по Wi‑Fi, чтобы не съесть трафик; если
 *   браузер не говорит, какая сеть, — считаем, что Wi‑Fi, и не блокируем.
 *
 * Пока переключатель выключен, всё здесь — пустые вызовы: подписка на стор и
 * таймер старта безопасно живут всегда.
 */

import { describeOfflineFailure, isBlockingFailure } from './offlineErrors';
import type { UnifiedTrack } from '../types/music';
import { db, getSetting, setSetting, type OfflineTrackRecord } from './db';
import { offlineStorage } from './offlineStorage';
import { offlineMode } from './offlineMode';
import { detectPlatform, type PlatformKind } from './nativeBridge';
import { useLibraryStore } from '../store/useLibraryStore';

/** Сколько отказов «источник не пускает» подряд останавливают проход очереди. */
export const BLOCKED_STREAK_LIMIT = 3;

export const FAVORITES_AUTO_SETTING = 'offline.favorites.auto';
export const FAVORITES_WIFI_ONLY_SETTING = 'offline.favorites.wifiOnly';
export const FAVORITES_LIMIT_SETTING = 'offline.favorites.limitBytes';

const GIB = 1024 * 1024 * 1024;

/** `bytes: 0` — без лимита: качаем всё избранное, пока есть место на диске. */
export const FAVORITES_LIMIT_OPTIONS: ReadonlyArray<{ label: string; bytes: number }> = [
  { label: '1 ГБ', bytes: GIB },
  { label: '2 ГБ', bytes: 2 * GIB },
  { label: '5 ГБ', bytes: 5 * GIB },
  { label: '10 ГБ', bytes: 10 * GIB },
  { label: 'Без лимита', bytes: 0 }
];

export const DEFAULT_FAVORITES_LIMIT_BYTES = 5 * GIB;

/** Какая сеть сейчас, насколько браузер готов об этом сказать. */
export type ConnectionKind = 'wifi' | 'cellular' | 'offline';

interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
}

interface NavigatorLike {
  onLine?: boolean;
  connection?: NetworkInformationLike;
}

/**
 * Определяет тип сети по `navigator.connection`.
 *
 * `type` отдаёт только Chromium на Android — ровно там, где это и нужно. Без
 * него остаётся `effectiveType`: он про скорость, а не про носитель, но «2g/3g»
 * на телефоне почти всегда означает сотовую сеть, а «4g» ставится и Wi‑Fi.
 * Когда нет ни того ни другого — считаем Wi‑Fi: лучше лишний раз скачать, чем
 * молча не скачать никогда.
 */
export function classifyConnection(nav: NavigatorLike | undefined = globalNavigator()): ConnectionKind {
  if (!nav) return 'wifi';
  if (nav.onLine === false) return 'offline';
  const connection = nav.connection;
  if (!connection) return 'wifi';
  const type = String(connection.type || '').toLowerCase();
  if (type === 'none') return 'offline';
  if (type === 'cellular') return 'cellular';
  if (type === 'wifi' || type === 'ethernet') return 'wifi';
  const effective = String(connection.effectiveType || '').toLowerCase();
  if (effective === 'slow-2g' || effective === '2g' || effective === '3g') return 'cellular';
  return 'wifi';
}

function globalNavigator(): NavigatorLike | undefined {
  return typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorLike);
}

/**
 * «1,3 ГБ», «640 МБ» — по-русски, с запятой: это строка для настроек, а не для
 * журнала. `formatBytes` из хранилища пишет «1.3 GB», и рядом с «из 5 ГБ» это
 * выглядело бы как два языка в одной фразе.
 */
export function formatRuBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${Math.max(1, Math.round(mib))} МБ`;
  const gib = mib / 1024;
  const rounded = gib >= 10 ? Math.round(gib).toString() : gib.toFixed(1).replace('.', ',').replace(/,0$/, '');
  return `${rounded} ГБ`;
}

export interface OfflineAutoDownloadState {
  enabled: boolean;
  wifiOnly: boolean;
  /** Показывать ли «только по Wi‑Fi»: на ПК сотовой сети не бывает. */
  wifiOnlyApplies: boolean;
  limitBytes: number;
  /** Сколько треков в избранном (без 30-секундных отрывков). */
  favoritesTotal: number;
  /** Сколько из них уже лежит офлайн. */
  favoritesOffline: number;
  /** Сколько ждёт очереди. */
  queued: number;
  /** Занято всем офлайн-кэшем, не только избранным: лимит считается по нему. */
  usedBytes: number;
  downloadingTrackId: string | null;
  downloadingProgress: number;
  /** Очередь стоит, потому что сеть сотовая, а разрешён только Wi‑Fi. */
  waitingForWifi: boolean;
  /** Лимит достигнут, и освободить место, не удаляя избранное, нельзя. */
  storageFull: boolean;
  lastError: string | null;
}

type Listener = (state: OfflineAutoDownloadState) => void;

/** Ручки для тестов: сеть, платформа и паузы подменяются без таймеров-фейков. */
export interface AutoDownloadDeps {
  platform: () => PlatformKind;
  connection: () => ConnectionKind;
  /** Пауза между треками: даёт плееру и каналу передохнуть. */
  pauseBetweenTracksMs: number;
  /** Отсрочка первого прохода после запуска: пусть сначала поднимется плеер. */
  startupDelayMs: number;
  /** Слипание частых добавлений в избранное в один проход. */
  favoritesDebounceMs: number;
}

class OfflineAutoDownloadService {
  private enabled = false;
  private wifiOnly = true;
  private limitBytes = DEFAULT_FAVORITES_LIMIT_BYTES;
  private favoritesTotal = 0;
  private favoritesOffline = 0;
  private queued = 0;
  private usedBytes = 0;
  private downloadingTrackId: string | null = null;
  private downloadingProgress = 0;
  private waitingForWifi = false;
  private storageFull = false;
  private lastError: string | null = null;

  private initialised: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  /** Пока шёл проход, попросили ещё один — после текущего запускаем заново. */
  private rerunRequested = false;
  private stopStart: (() => void) | null = null;
  private readonly listeners = new Set<Listener>();

  public readonly deps: AutoDownloadDeps = {
    platform: () => detectPlatform(),
    connection: () => classifyConnection(),
    pauseBetweenTracksMs: 3_000,
    startupDelayMs: 15_000,
    favoritesDebounceMs: 2_000
  };

  /** Читает сохранённые настройки. Повторные вызовы ничего не перечитывают. */
  public init(): Promise<void> {
    if (!this.initialised) {
      this.initialised = (async () => {
        const [enabled, wifiOnly, limitBytes] = await Promise.all([
          getSetting<boolean>(FAVORITES_AUTO_SETTING, false),
          getSetting<boolean>(FAVORITES_WIFI_ONLY_SETTING, true),
          getSetting<number>(FAVORITES_LIMIT_SETTING, DEFAULT_FAVORITES_LIMIT_BYTES)
        ]);
        this.enabled = enabled === true;
        this.wifiOnly = wifiOnly !== false;
        this.limitBytes = this.sanitizeLimit(limitBytes);
        this.notify();
      })().catch((err) => {
        console.error('[OfflineAutoDownload] Не удалось прочитать настройки:', err);
      });
    }
    return this.initialised;
  }

  public getState(): OfflineAutoDownloadState {
    return {
      enabled: this.enabled,
      wifiOnly: this.wifiOnly,
      wifiOnlyApplies: this.wifiOnlyApplies(),
      limitBytes: this.limitBytes,
      favoritesTotal: this.favoritesTotal,
      favoritesOffline: this.favoritesOffline,
      queued: this.queued,
      usedBytes: this.usedBytes,
      downloadingTrackId: this.downloadingTrackId,
      downloadingProgress: this.downloadingProgress,
      waitingForWifi: this.waitingForWifi,
      storageFull: this.storageFull,
      lastError: this.lastError
    };
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.lastError = null;
    this.storageFull = false;
    this.waitingForWifi = false;
    if (!enabled && this.downloadingTrackId) {
      // Выключили — текущую загрузку бросаем, уже скачанное остаётся: просили
      // перестать качать, а не потерять.
      offlineStorage.abortDownload(this.downloadingTrackId);
    }
    this.notify();
    await setSetting(FAVORITES_AUTO_SETTING, enabled);
    if (enabled) void this.sync();
  }

  public async setWifiOnly(wifiOnly: boolean): Promise<void> {
    this.wifiOnly = wifiOnly;
    this.notify();
    await setSetting(FAVORITES_WIFI_ONLY_SETTING, wifiOnly);
    // Сняли ограничение, пока очередь ждала Wi‑Fi, — пусть идёт.
    if (!wifiOnly && this.waitingForWifi) void this.sync();
  }

  public async setLimitBytes(bytes: number): Promise<void> {
    this.limitBytes = this.sanitizeLimit(bytes);
    this.storageFull = false;
    this.notify();
    await setSetting(FAVORITES_LIMIT_SETTING, this.limitBytes);
    // Новый лимит должен подействовать сразу: и выселить лишнее при меньшем, и
    // докачать остаток при большем.
    if (this.enabled) void this.sync();
  }

  /**
   * «Скачать сейчас»: проход независимо от переключателя — человек попросил
   * явно. Ограничение по Wi‑Fi при этом остаётся: трафик он не просил тратить.
   */
  public runNow(): Promise<void> {
    this.lastError = null;
    this.storageFull = false;
    this.notify();
    return this.sync({ force: true });
  }

  /**
   * Пересчитывает «42 из 118 · 1,3 ГБ», ничего не скачивая. Настройки зовут
   * это при открытии, чтобы цифры были честными и при выключенной службе.
   */
  public async refreshStats(): Promise<void> {
    try {
      const favorites = this.favorites();
      const records = await db.offlineTracks.toArray();
      const have = new Set(records.map((record) => record.id));
      this.favoritesTotal = favorites.length;
      this.favoritesOffline = favorites.filter((track) => have.has(track.id)).length;
      this.queued = this.favoritesTotal - this.favoritesOffline;
      this.usedBytes = records.reduce((sum, record) => sum + this.recordSize(record), 0);
      this.notify();
    } catch (err) {
      console.warn('[OfflineAutoDownload] Не удалось посчитать офлайн-избранное:', err);
    }
  }

  /**
   * Заводит фоновую работу: первый проход с отсрочкой, затем — на каждое
   * пополнение избранного и на возвращение Wi‑Fi. Возвращает остановку.
   * Повторный вызов ничего не дублирует.
   */
  public start(): () => void {
    if (this.stopStart) return this.stopStart;

    let booted = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const startupTimer = setTimeout(() => {
      booted = true;
      void this.sync();
    }, this.deps.startupDelayMs);

    // Пока не прошёл стартовый таймер, пополнения не считаются: загрузка
    // медиатеки из базы тоже меняет `favorites`, и без этой защиты первый
    // проход срывался бы в первую же секунду, обгоняя плеер.
    const unsubscribeStore = useLibraryStore.subscribe((state, prev) => {
      if (!booted || state.favorites === prev.favorites) return;
      const before = new Set(prev.favorites.map((track) => track.id));
      const added = state.favorites.some((track) => !before.has(track.id));
      if (!added) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void this.sync();
      }, this.deps.favoritesDebounceMs);
    });

    const onNetworkChange = () => {
      if (this.waitingForWifi) void this.sync();
    };
    const connection = globalNavigator()?.connection;
    connection?.addEventListener?.('change', onNetworkChange);
    if (typeof window !== 'undefined') window.addEventListener('online', onNetworkChange);

    this.stopStart = () => {
      clearTimeout(startupTimer);
      if (debounce) clearTimeout(debounce);
      unsubscribeStore();
      connection?.removeEventListener?.('change', onNetworkChange);
      if (typeof window !== 'undefined') window.removeEventListener('online', onNetworkChange);
      this.stopStart = null;
    };
    return this.stopStart;
  }

  /**
   * Один проход по избранному: что не лежит офлайн — скачать, по одному.
   *
   * Параллельных проходов не бывает: второй вызов во время первого лишь просит
   * повторить, когда первый закончится, — иначе один и тот же трек качался бы
   * дважды, а счётчики дрались бы друг с другом.
   */
  public sync(options: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.pass(options.force === true).finally(() => {
      this.running = null;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.sync();
      }
    });
    return this.running;
  }

  // -- внутренности ---------------------------------------------------------

  private async pass(force: boolean): Promise<void> {
    await this.init();
    await this.refreshStats();
    if (!this.enabled && !force) return;

    // Неудачники этого прохода: повторять их тут же бессмысленно — ответ будет
    // тот же. Следующий проход начнёт с чистого листа.
    const failed = new Set<string>();
    // Подряд идущие отказы «источник не пускает» (проверка на робота, нет сети).
    let blockedInRow = 0;
    // Ошибка живёт до следующего прохода, а не до следующего удачного трека:
    // сломанный остаётся в очереди, и человеку важно знать, почему он там.
    this.lastError = null;

    while (this.enabled || force) {
      const favorites = this.favorites();
      const favoriteIds = new Set(favorites.map((track) => track.id));
      const records = await db.offlineTracks.toArray();
      const have = new Set(records.map((record) => record.id));
      const next = favorites.find(
        (track) => !have.has(track.id) && !failed.has(track.id) && !offlineStorage.isDownloading(track.id)
      );
      if (!next) break;

      if (this.wifiOnlyApplies() && this.wifiOnly && this.deps.connection() !== 'wifi') {
        // Не ошибка — ожидание: слушатель сети позовёт `sync()` снова.
        this.waitingForWifi = true;
        this.notify();
        return;
      }
      this.waitingForWifi = false;

      if (!(await this.makeRoom(records, favoriteIds))) {
        this.storageFull = true;
        this.notify();
        return;
      }

      this.downloadingTrackId = next.id;
      this.downloadingProgress = 0;
      this.notify();
      try {
        await offlineStorage.downloadTrack(
          next,
          (pct) => {
            this.downloadingProgress = pct;
            this.notify();
          },
          // То же качество, что выбрано для офлайн-режима: два разных
          // «качества сохранённого» рядом никто бы не понял.
          { compressBitrateKbps: offlineMode.getBitrateKbps() }
        );
        if (!(await offlineStorage.isDownloaded(next.id))) {
          // Загрузку прервали (выключили службу) — проход окончен, следующий
          // начнётся с чистого листа.
          break;
        }
        // Не `autoCached`: офлайн-режим под своим лимитом избранное не трогает.
        await this.stamp(next.id);
        blockedInRow = 0;
      } catch (err) {
        // Один недоступный трек не останавливает остальные: он остаётся в
        // очереди и будет пробоваться на следующем проходе.
        this.lastError = describeOfflineFailure(err);
        console.warn(`[OfflineAutoDownload] Трек ${next.id} не сохранён:`, err);
        failed.add(next.id);
        blockedInRow = isBlockingFailure(err) ? blockedInRow + 1 : 0;
      } finally {
        this.downloadingTrackId = null;
        this.downloadingProgress = 0;
      }

      await this.refreshStats();
      /*
       * Источник не пускает три раза подряд — проход окончен. Дело уже не в
       * песне: следующие восемьдесят получили бы тот же ответ, а каждый лишний
       * запрос только продлевает проверку «вы не робот». Очередь никуда не
       * девается и продолжится со следующего прохода (запуск, новое сердечко,
       * «Скачать сейчас»).
       */
      if (blockedInRow >= BLOCKED_STREAK_LIMIT) break;
      // Пауза между треками — только если есть что качать дальше.
      const remaining = this.queued - failed.size;
      if (remaining > 0 && this.deps.pauseBetweenTracksMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.deps.pauseBetweenTracksMs));
      }
    }

    await this.refreshStats();
  }

  /**
   * Освобождает место под следующий трек, если лимит достигнут.
   *
   * Уходят копии не из избранного, сначала те, что дольше всех не включали.
   * `false` — освободить нечего: остались только любимые, и их мы не удаляем.
   */
  private async makeRoom(records: OfflineTrackRecord[], favoriteIds: Set<string>): Promise<boolean> {
    if (this.limitBytes <= 0) return true;
    let total = records.reduce((sum, record) => sum + this.recordSize(record), 0);
    if (total < this.limitBytes) return true;

    const evictable = records
      .filter((record) => !favoriteIds.has(record.id))
      .sort((a, b) => (a.lastUsedAt ?? a.downloadedAt ?? 0) - (b.lastUsedAt ?? b.downloadedAt ?? 0));

    for (const record of evictable) {
      if (total < this.limitBytes) break;
      try {
        await offlineStorage.deleteOfflineTrack(record.id);
        total -= this.recordSize(record);
      } catch (err) {
        console.warn(`[OfflineAutoDownload] Не удалось освободить место (${record.id}):`, err);
      }
    }
    this.usedBytes = total;
    return total < this.limitBytes;
  }

  private favorites(): UnifiedTrack[] {
    const list = useLibraryStore.getState().favorites;
    if (!Array.isArray(list)) return [];
    // Отрывки SoundCloud в 30 секунд сохранять незачем, а проверять их
    // каждый проход — тем более.
    const seen = new Set<string>();
    return list.filter((track) => {
      if (!track || !track.id || track.isPreview || seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });
  }

  private wifiOnlyApplies(): boolean {
    return this.deps.platform() === 'mobile';
  }

  private sanitizeLimit(bytes: unknown): number {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      return DEFAULT_FAVORITES_LIMIT_BYTES;
    }
    return Math.floor(bytes);
  }

  private recordSize(record: { sizeBytes?: number; blob?: Blob }): number {
    return record.sizeBytes || record.blob?.size || 0;
  }

  private async stamp(trackId: string): Promise<void> {
    try {
      const record = await db.offlineTracks.get(trackId);
      if (!record) return;
      await db.offlineTracks.put({ ...record, lastUsedAt: Date.now() });
    } catch (err) {
      console.warn('[OfflineAutoDownload] Не удалось отметить сохранённый трек:', err);
    }
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[OfflineAutoDownload] Ошибка в слушателе состояния:', err);
      }
    }
  }
}

export const offlineAutoDownload = new OfflineAutoDownloadService();

/**
 * Точка входа для `App.tsx`: одна строка в стартовом `useEffect`. Возвращает
 * остановку — для симметрии с остальными фоновыми службами.
 */
export function startOfflineAutoDownload(): () => void {
  return offlineAutoDownload.start();
}
