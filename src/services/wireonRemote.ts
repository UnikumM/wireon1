/**
 * Удалённая сторона синхронизации — наш сервер (`server/wireon_music`).
 *
 * До этого в `cloudSync` стояла заглушка `NullRemoteAdapter`, и «облачная
 * синхронизация» была движком без второй стороны: всё писалось в местную базу и
 * там оставалось. Здесь появляется вторая сторона.
 *
 * Три решения, из-за которых этот файл выглядит именно так:
 *
 * - **Личность подтверждает Discord, а не наш токен.** Токен сервера лежит
 *   внутри APK, а APK распаковывается: если бы плейлисты выдавались по нему,
 *   их читал бы любой желающий. Поэтому в запрос уходят оба — наш держит ручку
 *   закрытой от интернета, а чей это шкаф, сервер спрашивает у Discord.
 * - **Один запрос на весь заход.** У движка три отдельных чтения (плейлисты,
 *   избранное, удалённое), но это одна и та же картина мира; три обращения по
 *   мобильной сети ради неё — это втрое больше поводов не дождаться. Ответ
 *   держится ровно на время захода.
 * - **Ссылка на поток наружу не уходит.** Она привязана к адресу и живёт часы;
 *   на другом устройстве это мусор, который к тому же раздувает отправку.
 */

import { Playlist, UnifiedTrack } from '../types/music';
import { RemoteDeletions, RemoteSyncAdapter } from '../types/auth';
import { resolveServerConfig } from './nativeBridge';

/** Сколько ответ на чтение считается свежим. */
const SNAPSHOT_TTL_MS = 5000;

/** Дольше этого ждать синхронизацию незачем: она фоновая и повторится. */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Ожидание изменений держится дольше обычного запроса — в этом его смысл.
 *
 * Сервер отпускает запрос сам на двадцати пяти секундах; тридцать пять здесь —
 * запас на дорогу, чтобы обрыв по нашему сроку не выглядел отказом сервера.
 */
const WAIT_TIMEOUT_MS = 35000;

export interface RemoteSnapshot {
  playlists: Playlist[];
  favorites: UnifiedTrack[];
  deleted: RemoteDeletions;
}

const EMPTY: RemoteSnapshot = {
  playlists: [],
  favorites: [],
  deleted: { playlists: [], favorites: [], deletedAt: { playlists: {}, favorites: {} } }
};

/**
 * Убирает поля, которым нечего делать на другом устройстве.
 *
 * `streamUrl` подписан вместе с адресом того, кто его получил, и протухает за
 * часы: приехав на телефон, он не сыграет, но место в отправке займёт.
 */
export function stripDeviceFields(track: UnifiedTrack): UnifiedTrack {
  const { streamUrl: _url, streamExpiry: _expiry, ...portable } = track;
  return portable as UnifiedTrack;
}

/** Оставляет из ответа только пары «идентификатор — время», остальное отбрасывает. */
function stampMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const stamps: Record<string, number> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) stamps[id] = value;
  }
  return stamps;
}

function stripPlaylist(playlist: Playlist): Playlist {
  return { ...playlist, tracks: (playlist.tracks || []).map(stripDeviceFields) };
}

export interface WireonRemoteOptions {
  /** Откуда берётся токен Discord. Функцией, чтобы адаптер не зависел от стора. */
  getDiscordToken: () => string | null;
  baseUrl?: string | null;
  serverToken?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Отказ, случившийся до ответа сервера, — своими словами.
 *
 * Браузер на любую сетевую беду бросает `TypeError: Failed to fetch` и не
 * объясняет причину: так выглядит и выключенный сервер, и запрет источнику, и
 * оборванная сеть. Эти три слова доезжали до владельца как есть — он видел в
 * меню аккаунта «Failed to fetch» и не мог знать, у него ли пропал интернет или
 * это мы. Отсюда пересказ: сказать хотя бы то, что мы знаем наверняка — ответа
 * не было вовсе.
 */
export function describeTransportFailure(err: unknown, aborted: boolean): Error {
  if (aborted) {
    return new Error('WIREON_SYNC_TIMEOUT: сервер Wireon не ответил вовремя');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new Error('WIREON_SYNC_OFFLINE: нет подключения к сети');
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(
    `WIREON_SYNC_UNREACHABLE: не удалось связаться с сервером Wireon (${detail})`
  );
}

export class WireonRemoteAdapter implements RemoteSyncAdapter {
  public readonly id = 'wireon';

  private readonly getDiscordToken: () => string | null;
  private readonly baseUrl: string | null;
  private readonly serverToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private snapshot: RemoteSnapshot | null = null;
  private snapshotAt = 0;
  private inFlight: Promise<RemoteSnapshot> | null = null;

  constructor(options: WireonRemoteOptions) {
    const config = resolveServerConfig(options.baseUrl, options.serverToken);
    this.baseUrl = config?.baseUrl ?? null;
    this.serverToken = config?.token ?? null;
    this.getDiscordToken = options.getDiscordToken;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
  }

  /**
   * Настроен ли обмен.
   *
   * Гость сюда не попадает не из вредности: без подтверждённой личности сервер
   * не знает, чей это шкаф, и складывать записи было бы некуда.
   */
  public isConfigured(): boolean {
    return Boolean(this.baseUrl && this.serverToken && this.getDiscordToken());
  }

  /** Сбрасывает запомненный ответ. Нужен при смене аккаунта и тестам. */
  public forget(): void {
    this.snapshot = null;
    this.snapshotAt = 0;
    this.inFlight = null;
  }

  // -- чтение ---------------------------------------------------------------

  public async pullPlaylists(): Promise<Playlist[]> {
    return (await this.readSnapshot()).playlists;
  }

  public async pullFavorites(): Promise<UnifiedTrack[]> {
    return (await this.readSnapshot()).favorites;
  }

  /**
   * Что было удалено на других устройствах.
   *
   * Без этого удаление не доезжает вовсе: движок сливает пришедшее в местное, а
   * потом отправляет местное целиком — и запись, стёртая на телефоне, приезжает
   * обратно с ПК, у которого не было причины её забыть. Причина — здесь.
   */
  public async pullDeletions(): Promise<RemoteDeletions> {
    return (await this.readSnapshot()).deleted;
  }

  // -- запись ---------------------------------------------------------------

  public async pushPlaylists(playlists: Playlist[]): Promise<number> {
    if (!playlists.length) return 0;
    const body = { playlists: playlists.map(stripPlaylist) };
    const answer = await this.send('POST', '/v1/sync', body);
    this.forget();
    return typeof answer?.playlists === 'number' ? answer.playlists : 0;
  }

  public async pushFavorites(tracks: UnifiedTrack[]): Promise<number> {
    if (!tracks.length) return 0;
    const body = { favorites: tracks.map(stripDeviceFields) };
    const answer = await this.send('POST', '/v1/sync', body);
    this.forget();
    return typeof answer?.favorites === 'number' ? answer.favorites : 0;
  }

  public async deletePlaylist(playlistId: string): Promise<boolean> {
    return this.remove('playlists', playlistId);
  }

  public async deleteFavorite(trackId: string): Promise<boolean> {
    return this.remove('favorites', trackId);
  }

  // -- внутреннее -----------------------------------------------------------

  private async remove(kind: 'playlists' | 'favorites', id: string): Promise<boolean> {
    if (!id) return false;
    const answer = await this.send('DELETE', `/v1/sync/${kind}/${encodeURIComponent(id)}`);
    this.forget();
    return answer?.deleted === true;
  }

  private async readSnapshot(): Promise<RemoteSnapshot> {
    if (this.snapshot && this.now() - this.snapshotAt < SNAPSHOT_TTL_MS) {
      return this.snapshot;
    }
    // Совпавшие по времени чтения ждут один запрос, а не заводят свой: движок
    // спрашивает плейлисты и избранное подряд, и это одна картина мира.
    if (!this.inFlight) {
      this.inFlight = this.fetchSnapshot().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchSnapshot(): Promise<RemoteSnapshot> {
    const body = await this.send('GET', '/v1/sync');
    const snapshot: RemoteSnapshot = {
      playlists: Array.isArray(body?.playlists) ? body.playlists : [],
      favorites: Array.isArray(body?.favorites) ? body.favorites : [],
      deleted: {
        playlists: Array.isArray(body?.deleted?.playlists) ? body.deleted.playlists : [],
        favorites: Array.isArray(body?.deleted?.favorites) ? body.deleted.favorites : [],
        // Даты удаления сервер прислать может и не уметь: сборка приложения
        // обновляется раньше него. Тогда остаётся прежнее поведение.
        deletedAt: {
          playlists: stampMap(body?.deletedAt?.playlists),
          favorites: stampMap(body?.deletedAt?.favorites)
        }
      }
    };
    this.snapshot = snapshot;
    this.snapshotAt = this.now();
    return snapshot;
  }

  /**
   * Ждёт, пока у человека что-нибудь изменится на другом устройстве.
   *
   * Зачем это поверх обычной сверки: на Android слушать брокер нельзя вовсе —
   * страница живёт на `https`, а брокер отвечает по `ws://`, и браузер
   * запрещает такое соединение сам (замерено 2026-09-02). Обычные запросы
   * оттуда проходят, поэтому ожидание сделано обычным запросом: сервер молчит,
   * пока сказать нечего, и отвечает сразу, как только есть.
   *
   * Свой срок ожидания, а не общий {@link REQUEST_TIMEOUT_MS}: этот запрос
   * обязан висеть дольше обычного — в том и смысл. Сервер сам отпускает его на
   * двадцати пяти секундах, здесь запас на дорогу.
   *
   * @param since отметка, которую клиент видел последней. Отстала — ответ
   *   придёт немедленно, без ожидания.
   */
  public async waitForChange(since: number): Promise<{ revision: number; changed: boolean }> {
    const body = (await this.send('GET', `/v1/sync/wait?since=${encodeURIComponent(String(since))}`, undefined, WAIT_TIMEOUT_MS)) as {
      revision?: unknown;
      changed?: unknown;
    };
    const revision = typeof body?.revision === 'number' && Number.isFinite(body.revision) ? body.revision : since;
    return { revision, changed: body?.changed === true };
  }

  private async send(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<any> {
    if (!this.baseUrl || !this.serverToken) {
      throw new Error('WIREON_SYNC_NOT_CONFIGURED: адрес или токен сервера не заданы');
    }
    const discordToken = this.getDiscordToken();
    if (!discordToken) {
      throw new Error('WIREON_SYNC_NOT_AUTHENTICATED: нет токена Discord');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-Wireon-Token': this.serverToken,
            'X-Discord-Token': discordToken,
            ...(payload === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: controller.signal
        });
      } catch (err) {
        throw describeTransportFailure(err, controller.signal.aborted);
      }

      if (!response.ok) {
        let code = `HTTP_${response.status}`;
        let detail = `сервер ответил ${response.status}`;
        try {
          const failure = (await response.json()) as { error?: unknown; detail?: unknown };
          if (typeof failure?.error === 'string' && failure.error) code = failure.error;
          if (typeof failure?.detail === 'string' && failure.detail) detail = failure.detail;
        } catch {
          // Тело не JSON — кода из статуса хватает.
        }
        throw new Error(`${code}: ${detail}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Адаптер по настройкам сборки, либо `null`, если сервер ей не задан. */
export function createWireonRemote(
  getDiscordToken: () => string | null,
  fetchImpl?: typeof fetch
): WireonRemoteAdapter | null {
  if (!resolveServerConfig()) return null;
  return new WireonRemoteAdapter({ getDiscordToken, fetchImpl });
}

/** Пустой ответ — для тестов и для случая, когда сервера нет вовсе. */
export const EMPTY_SNAPSHOT = EMPTY;
