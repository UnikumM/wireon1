import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { youtubeService } from '../../services/youtube';
import { soundCloudService } from '../../services/soundcloud';
import { parseCollectionLink } from '../../services/collections';
import { getClientId, getFreshAccessToken, runSpotifyLogin } from '../../services/spotifyAuth';
import { fetchLikedSongs, fetchPlaylistItems, fetchPlaylists, SpotifyPlaylistSummary } from '../../services/spotifyLibrary';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Music,
  ArrowRight,
  Disc,
  Play,
  Import,
  RotateCcw,
  Upload,
  FileText,
  Search,
  Check
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import {
  playlistImporter,
  PlatformType,
  ParsedPlaylistItem,
  ImportMatch
} from '../../services/playlistImporter';
import { parsePlaylistFile, PlaylistFileError } from '../../services/playlistTransfer';
import { rankCandidates } from '../../services/trackMatching';
import { forgetLink, rememberLink } from '../../services/matchLinks';
import { searchAggregator } from '../../services/aggregator';
import { UnifiedTrack } from '../../types/music';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { pluralize } from '../../utils/plural';
import { UNKNOWN_ARTIST, UNTITLED_PLAYLIST } from '../../utils/placeholders';
import { formatDuration } from '../../utils/time';
import { ICON } from '../../styles/icons';

export interface ImportPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported?: (playlistId: string) => void;
}

type ImportStep = 'input' | 'preview' | 'resolving' | 'complete';

/** Откуда пришёл плейлист: со стороннего сервиса или из файла. */
type PreviewOrigin =
  | { kind: 'platform'; platform: PlatformType }
  | { kind: 'file'; filename: string };

interface PreviewState {
  title: string;
  description?: string;
  coverUrl?: string;
  /** Строки, которые придётся искать в источниках. */
  items: ParsedPlaylistItem[];
  /** Готовые треки — так переносится наш собственный файл, без поиска. */
  readyTracks: UnifiedTrack[];
  origin: PreviewOrigin;
}

/** Состояние ручного выбора для одной ненайденной строки. */
interface ManualState {
  candidates: UnifiedTrack[] | null;
  isSearching: boolean;
  addedId?: string;
}

interface PlatformBadgeConfig {
  name: string;
  color: string;
  bg: string;
  border: string;
}

/**
 * Метка площадки берётся из темы, а не из фирменной палитры сервиса.
 *
 * Раньше здесь стояли фирменные цвета литералами — единственное место в
 * приложении, красившееся мимо темы. На светлых темах чистый `#FF0033` на белом
 * оказывался единственным кричащим пятном в окне. Приглушённые до нашей пастели
 * пары `--badge-*` уже описаны в theme.css и имеют светлый вариант.
 */
function badge(name: string, token: string): PlatformBadgeConfig {
  return {
    name,
    color: `var(--badge-${token}-text)`,
    bg: `var(--badge-${token}-bg)`,
    border: `var(--badge-${token}-border)`
  };
}

/** Метки площадок в окне импорта. Цвета — из темы, см. `badge` выше. */
const PLATFORM_CONFIG: Record<PlatformType, PlatformBadgeConfig> = {
  youtube: badge('YouTube Music', 'youtube'),
  soundcloud: badge('SoundCloud', 'soundcloud'),
  spotify: badge('Spotify', 'spotify'),
  yandex: badge('Yandex Music', 'yandex'),
  vk: badge('VK Music', 'vk'),
  apple: badge('Apple Music', 'apple')
};

/** `nochnaya-doroga-2026-08-18.wireon.json` → `nochnaya-doroga-2026-08-18`. */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.(wireon\.)?[a-z0-9]{2,5}$/i, '').trim() || UNTITLED_PLAYLIST;
}

/**
 * Импорт из Spotify по-настоящему: через вход, а не через публичную страницу.
 *
 * Разбор ссылки рядом читает страницу плейлиста, а она отдаёт первую сотню
 * треков и ничего не знает про «Любимые» и приватные списки. Отсюда же
 * приезжает всё целиком.
 */
/**
 * Треки плейлиста Spotify: через API, а если он отказал — с публичной страницы.
 *
 * После миграции Spotify (март 2026) API отдаёт содержимое только своих и
 * совместных плейлистов. Чужой плейлист, на который человек подписан, отвечает
 * отказом — и раньше этот отказ показывался красной надписью вместо переноса.
 * Публичная страница читает любой открытый плейлист, но только первую сотню.
 */
async function readSpotifyPlaylist(
  playlistId: string
): Promise<{ title?: string; items: ParsedPlaylistItem[]; complete: boolean }> {
  const token = await getFreshAccessToken().catch(() => null);
  if (token) {
    try {
      const items = await fetchPlaylistItems(token, playlistId);
      if (items.length > 0) return { items, complete: true };
    } catch (err) {
      console.warn('[ImportPlaylistModal] Spotify API не отдал плейлист, читаю страницу:', err);
    }
  }
  const parsed = await playlistImporter.parsePlaylistUrl(`https://open.spotify.com/playlist/${playlistId}`);
  return { title: parsed.title, items: parsed.items ?? [], complete: false };
}

const SpotifyLibraryBlock: React.FC<{ onPicked: (title: string, items: ParsedPlaylistItem[]) => void }> = ({
  onPicked
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null);

  const available = Boolean(getClientId()) && typeof window !== 'undefined' && Boolean(window.electronAPI?.onDeepLink);
  if (!available) return null;

  const load = async (token: string) => {
    setPlaylists(await fetchPlaylists(token));
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = (await getFreshAccessToken()) || (await runSpotifyLogin()).accessToken;
      await load(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind: 'liked' | 'playlist', playlist?: SpotifyPlaylistSummary) => {
    setBusy(true);
    setError(null);
    try {
      let items: ParsedPlaylistItem[];
      if (kind === 'liked') {
        const token = await getFreshAccessToken();
        if (!token) throw new Error('Вход в Spotify устарел — войдите заново');
        items = await fetchLikedSongs(token);
      } else {
        items = (await readSpotifyPlaylist(playlist!.id)).items;
      }
      if (items.length === 0) {
        setError('В этом списке нет треков.');
        return;
      }
      onPicked(kind === 'liked' ? 'Любимые треки из Spotify' : playlist!.name, items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 pt-4 border-t-subtle">
      <p className="text-sm text-secondary" style={{ margin: '0 0 var(--space-3)' }}>
        Или войдите в Spotify — тогда можно перенести «Любимые» и выбрать плейлист из своего списка.
      </p>

      {error && (
        <p className="text-xs text-danger" style={{ margin: '0 0 var(--space-2)' }}>{error}</p>
      )}

      {!playlists && (
        <Button variant="secondary" onClick={connect} disabled={busy} data-testid="spotify-connect-btn">
          {busy ? 'Ждём Spotify…' : 'Войти в Spotify'}
        </Button>
      )}

      {playlists && (
        <ul className="m-0 p-0 grid gap-2 list-none" style={{ maxHeight: '260px', overflowY: 'auto' }}>
          <li>
            <Button variant="secondary" onClick={() => pick('liked')} disabled={busy} data-testid="spotify-liked-btn">
              Любимые треки
            </Button>
          </li>
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <Button variant="secondary" onClick={() => pick('playlist', playlist)} disabled={busy}>
                {playlist.name} · {playlist.trackCount}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const ImportPlaylistModal: React.FC<ImportPlaylistModalProps> = ({
  isOpen,
  onClose,
  onImported
}) => {
  const showToast = useUIStore((s) => s.showToast);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);

  const [url, setUrl] = useState('');
  const [step, setStep] = useState<ImportStep>('input');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [resolvedTracks, setResolvedTracks] = useState<UnifiedTrack[]>([]);
  const [matches, setMatches] = useState<ImportMatch[]>([]);
  const [manual, setManual] = useState<Record<number, ManualState>>({});
  const [progress, setProgress] = useState<{ resolved: number; total: number; current?: string }>({
    resolved: 0,
    total: 0
  });
  const [importedPlaylistId, setImportedPlaylistId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Detect platform in real-time as user types
  const detectedPlatform = useMemo(() => {
    if (!url.trim()) return null;
    return playlistImporter.detectPlatform(url);
  }, [url]);

  /** Ненайденные строки вместе с их номером — номер нужен для ручного выбора. */
  const unmatched = useMemo(
    () => matches.map((match, index) => ({ match, index })).filter((entry) => !entry.match.track),
    [matches]
  );

  /**
   * Строки, взятые из памяти прошлых подтверждений.
   *
   * Показываются отдельно, чтобы подтверждённое соответствие не превращалось в
   * необратимое: если однажды выбрали не ту запись, это видно здесь и снимается
   * одной кнопкой.
   */
  const remembered = useMemo(
    () => matches.map((match, index) => ({ match, index })).filter((entry) => entry.match.fromLink),
    [matches]
  );
  const [forgotten, setForgotten] = useState<Record<number, boolean>>({});

  const handleForgetLink = useCallback(
    async (index: number) => {
      const item = matches[index]?.item;
      if (!item) return;
      await forgetLink(item);
      setForgotten((prev) => ({ ...prev, [index]: true }));
      showToast('Соответствие забыто — при следующем переносе поищем заново', 'info');
    },
    [matches, showToast]
  );

  // Reset modal state when opened/closed
  useEffect(() => {
    if (!isOpen) {
      setTimeout(() => {
        setUrl('');
        setStep('input');
        setIsLoading(false);
        setError(null);
        setPreview(null);
        setResolvedTracks([]);
        setMatches([]);
        setManual({});
        setProgress({ resolved: 0, total: 0 });
        setImportedPlaylistId(null);
      }, 200);
    }
  }, [isOpen]);

  const handleFetchMetadata = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError('Вставьте ссылку на плейлист или альбом.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Плейлист YouTube Music переносится как есть: он уже состоит из тех
      // самых записей, которые мы играем, — искать и подбирать нечего, а
      // значит и подменить нечем.
      const detected = playlistImporter.detectPlatform(trimmed);
      if (detected === 'youtube' || detected === 'soundcloud') {
        let tracks: UnifiedTrack[] = [];
        let title: string | null = null;
        if (detected === 'youtube') {
          const listId = playlistImporter.extractYouTubePlaylistId(trimmed);
          tracks = listId ? await youtubeService.getPlaylistTracks(listId) : [];
        } else {
          // Плейлист SoundCloud — как есть, со своим названием.
          const link = parseCollectionLink(trimmed);
          const found = link ? await soundCloudService.getPlaylistWithTitle(link.ref) : null;
          tracks = found?.tracks ?? [];
          title = found?.title ?? null;
        }
        if (tracks.length === 0) {
          setError('Не удалось прочитать этот плейлист. Проверьте, что он доступен по ссылке всем.');
          setIsLoading(false);
          return;
        }

        setPreview({
          title: title || (detected === 'soundcloud' ? 'Плейлист из SoundCloud' : 'Плейлист из YouTube Music'),
          items: [],
          readyTracks: tracks,
          origin: { kind: 'platform', platform: detected }
        });
        setStep('preview');
        setIsLoading(false);
        return;
      }

      // Ссылка на Spotify, когда вход уже сделан: список берётся у них по-честному
      // и целиком. Публичная страница отдаёт первую сотню треков и молчит об
      // остальных — именно отсюда бралось «перенеслось не всё».
      if (playlistImporter.detectPlatform(trimmed) === 'spotify') {
        const spotifyId = /playlist[/:]([a-zA-Z0-9]+)/.exec(trimmed)?.[1];
        const token = spotifyId ? await getFreshAccessToken().catch(() => null) : null;
        // Отказ API (чужой плейлист, режим разработки) — не ошибка переноса:
        // ниже та же ссылка читается публичной страницей.
        const items =
          spotifyId && token
            ? await fetchPlaylistItems(token, spotifyId).catch((err) => {
                console.warn('[ImportPlaylistModal] Spotify API не отдал плейлист, читаю страницу:', err);
                return [] as ParsedPlaylistItem[];
              })
            : [];
        if (items.length > 0) {
          setPreview({
            title: 'Плейлист из Spotify',
            items,
            readyTracks: [],
            origin: { kind: 'platform', platform: 'spotify' }
          });
          setStep('preview');
          setIsLoading(false);
          return;
        }
      }

      const parsed = await playlistImporter.parsePlaylistUrl(trimmed);
      if (!parsed.items || parsed.items.length === 0) {
        setError('В этом плейлисте не нашлось ни одного трека. Проверьте, что он открыт для всех.');
        setIsLoading(false);
        return;
      }

      setPreview({
        title: parsed.title,
        description: parsed.description,
        coverUrl: parsed.coverUrl,
        items: parsed.items,
        readyTracks: [],
        origin: { kind: 'platform', platform: parsed.platform }
      });
      setStep('preview');
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать плейлист. Проверьте ссылку и попробуйте снова.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Плейлист из файла: наш `.wireon.json`, `.m3u8` из другого плеера или таблица.
   * Формат определяет `parsePlaylistFile` по содержимому — расширение не важно.
   */
  const handleFileChosen = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Сбрасываем сразу, иначе повторный выбор того же файла не даст события.
    event.target.value = '';
    if (!file) return;

    setIsLoading(true);
    setError(null);

    try {
      const text = await file.text();
      const parsed = parsePlaylistFile(text, file.name);
      if (parsed.items.length === 0 && parsed.tracks.length === 0) {
        setError('В файле не нашлось ни одного трека.');
        return;
      }

      setPreview({
        title: parsed.title === UNTITLED_PLAYLIST ? titleFromFilename(file.name) : parsed.title,
        description: parsed.description,
        items: parsed.items,
        readyTracks: parsed.tracks,
        origin: { kind: 'file', filename: file.name }
      });
      setStep('preview');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(err instanceof PlaylistFileError ? detail : `Не удалось прочитать файл: ${detail}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleStartResolution = async () => {
    if (!preview) return;
    if (preview.items.length === 0 && preview.readyTracks.length === 0) return;

    setStep('resolving');
    setIsLoading(true);
    setError(null);
    setMatches([]);
    setManual({});
    setProgress({ resolved: 0, total: preview.items.length });

    try {
      // Готовые треки из нашего файла искать не нужно — они уже играбельны.
      const found = preview.items.length
        ? await playlistImporter.matchImportedTracks(
            preview.items,
            (resCount, totCount, currentTitle) => {
              setProgress({ resolved: resCount, total: totCount, current: currentTitle });
            },
            5
          )
        : [];

      const matchedTracks = found
        .map((match) => match.track)
        .filter((track): track is UnifiedTrack => track !== null);
      const tracks = [...preview.readyTracks, ...matchedTracks];

      if (tracks.length === 0) {
        setMatches(found);
        setError('Ни один трек не удалось найти в источниках. Проверьте названия и попробуйте снова.');
        setStep('preview');
        return;
      }

      const description =
        preview.description ||
        (preview.origin.kind === 'platform'
          ? `Перенесено из ${PLATFORM_CONFIG[preview.origin.platform].name}`
          : `Перенесено из файла ${preview.origin.filename}`);

      const playlistId = await playlistImporter.saveToLibrary(preview.title, tracks, description);

      setMatches(found);
      setResolvedTracks(tracks);
      setImportedPlaylistId(playlistId);
      setStep('complete');
      showToast(
        `«${preview.title}» перенесён — ${pluralize(tracks.length, 'трек', 'трека', 'треков')}`,
        'success'
      );
      onImported?.(playlistId);
    } catch (err: any) {
      setError(err?.message || 'Не удалось найти и сохранить треки.');
      setStep('preview');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Ручной выбор для ненайденной строки. Сначала показываем кандидатов, которые
   * уже отобрал перенос, и только если их нет — идём искать заново.
   */
  const handleManualSearch = useCallback(
    async (index: number) => {
      const match = matches[index];
      if (!match) return;

      if (match.alternatives.length > 0) {
        setManual((prev) => ({
          ...prev,
          [index]: { candidates: match.alternatives, isSearching: false, addedId: prev[index]?.addedId }
        }));
        return;
      }

      setManual((prev) => ({
        ...prev,
        [index]: { candidates: null, isSearching: true, addedId: prev[index]?.addedId }
      }));

      const query = `${match.item.artist || ''} ${match.item.title}`.trim();
      try {
        const found = await searchAggregator.search(query, { source: 'all', limit: 8 });
        const ranked = rankCandidates(
          { title: match.item.title, artist: match.item.artist || undefined, duration: match.item.duration },
          found?.results ?? []
        ).map((entry) => entry.candidate);
        setManual((prev) => ({
          ...prev,
          [index]: { candidates: ranked, isSearching: false, addedId: prev[index]?.addedId }
        }));
      } catch {
        setManual((prev) => ({
          ...prev,
          [index]: { candidates: [], isSearching: false, addedId: prev[index]?.addedId }
        }));
        showToast('Поиск не удался — попробуйте позже', 'error');
      }
    },
    [matches, showToast]
  );

  const handlePickCandidate = useCallback(
    async (index: number, track: UnifiedTrack) => {
      if (!importedPlaylistId) return;

      const ok = await addTrackToPlaylist(importedPlaylistId, track);
      if (!ok) {
        showToast('Не удалось добавить трек в плейлист', 'error');
        return;
      }

      // Выбор человека — окончательный ответ для этой строки: в следующий раз
      // (другой плейлист, другое устройство, повторный перенос) подбор по
      // названию для неё не запускается вовсе.
      const item = matches[index]?.item;
      if (item) void rememberLink(item, track, true);

      setResolvedTracks((prev) => [...prev, track]);
      setManual((prev) => ({
        ...prev,
        [index]: { candidates: prev[index]?.candidates ?? null, isSearching: false, addedId: track.id }
      }));
      showToast(`«${track.title}» добавлен в плейлист`, 'success');
    },
    [addTrackToPlaylist, importedPlaylistId, matches, showToast]
  );

  const handleOpenCreatedPlaylist = () => {
    if (importedPlaylistId) {
      setActivePlaylistId(importedPlaylistId);
      setActiveView('playlist');
      onClose();
    }
  };

  const percentComplete = progress.total > 0
    ? Math.round((progress.resolved / progress.total) * 100)
    : 0;

  const previewCount = preview ? preview.items.length + preview.readyTracks.length : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="row gap-2">
          {/* Значок переноса, а не звёздочки: окно ровно про перенос. */}
          <Import size={ICON.lg} className="text-secondary" aria-hidden="true" />
          <span>Перенести плейлист</span>
        </div>
      }
      maxWidth="560px"
      data-testid="import-playlist-modal"
    >
      <div className="stack gap-4">
        {/* Error Banner */}
        {error && (
          <div
            role="alert"
            // Отказ появляется в ответ на нажатие — и обязан быть замечен.
            className="animate-drop-in radius-md text-danger text-sm row-start gap-2 py-3 px-4 bg-danger-soft"
            style={{ border: '1px solid var(--danger)' }}
            data-testid="import-error-banner"
          >
            <AlertCircle size={ICON.md} className="shrink-0 mt-px" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Step 1: Input URL */}
        {step === 'input' && (
          <form onSubmit={handleFetchMetadata} className="stack gap-4">
            <div>
              <label
                htmlFor="import-url-input"
                className="block text-sm weight-medium text-secondary mb-2"
              >
                Ссылка на плейлист или альбом
              </label>
              <div className="relative row">
                <input
                  id="import-url-input"
                  type="url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="https://open.spotify.com/playlist/… либо Яндекс Музыка, VK, Apple Music, YouTube, SoundCloud"
                  autoFocus
                  className="w-full" style={{ paddingRight: detectedPlatform ? '140px' : 'var(--space-3)' }}
                  data-testid="import-url-input"
                />

                {detectedPlatform && (
                  <div
                    style={{
                      position: 'absolute',
                      right: 'var(--space-2)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-1)',
                      padding: 'var(--space-1) var(--space-2)',
                      borderRadius: 'var(--radius-full)',
                      backgroundColor: PLATFORM_CONFIG[detectedPlatform].bg,
                      border: `1px solid ${PLATFORM_CONFIG[detectedPlatform].border}`,
                      color: PLATFORM_CONFIG[detectedPlatform].color,
                      fontSize: 'var(--text-xs)',
                      fontWeight: 'var(--weight-semibold)'
                    }}
                    data-testid="platform-detected-badge"
                  >
                    <Disc size={ICON.xs} />
                    <span>{PLATFORM_CONFIG[detectedPlatform].name}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Platform indicators */}
            <div>
              <div className="text-xs text-muted mb-2">
                Откуда можно переносить:
              </div>
              <div className="row-stretch wrap gap-2">
                {(['spotify', 'yandex', 'vk', 'apple'] as PlatformType[]).map((p) => {
                  const cfg = PLATFORM_CONFIG[p];
                  const isMatch = detectedPlatform === p;
                  return (
                    <div
                      key={p}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 'var(--space-1)',
                        padding: 'var(--space-1) var(--space-3)',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: isMatch ? cfg.bg : 'var(--surface-3)',
                        border: `1px solid ${isMatch ? cfg.border : 'var(--border-subtle)'}`,
                        color: isMatch ? cfg.color : 'var(--text-secondary)',
                        fontSize: 'var(--text-xs)',
                        fontWeight: isMatch ? 'var(--weight-semibold)' : 'var(--weight-normal)',
                        // `all` анимирует и то, что меняться не должно: вместе с
                        // цветом плашки браузер переходит `font-weight`, и текст
                        // на 150 мс проходит через дробные веса — на этом
                        // размере он просто размывается. Перечислены свойства,
                        // которым переход и нужен.
                        transition:
                          'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)'
                      }}
                      data-testid={`platform-chip-${p}`}
                    >
                      <span
                        style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          backgroundColor: isMatch ? cfg.color : 'var(--text-muted)'
                        }}
                      />
                      {cfg.name}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Файл плейлиста — второй способ переноса */}
            <div
              className="row justify-between gap-3 p-3 radius-md bg-surface-2" style={{ border: '1px dashed var(--border-subtle)' }}
            >
              <div className="min-0">
                <div className="text-sm text-primary weight-medium">
                  Или откройте файл плейлиста
                </div>
                <div className="text-xs text-muted mt-px">
                  Wireon Sounds (.json), .m3u8 из другого плеера, таблица .csv
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Upload size={ICON.sm} />}
                onClick={() => fileInputRef.current?.click()}
                data-testid="import-file-btn"
              >
                Выбрать файл
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.m3u,.m3u8,.csv,.txt,application/json,text/csv,text/plain,audio/x-mpegurl"
                onChange={(e) => void handleFileChosen(e)}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
                data-testid="import-file-input"
              />
            </div>

            <div className="row-stretch justify-end gap-3 mt-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Отмена
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={isLoading || !url.trim()}
                icon={isLoading ? <Loader2 size={ICON.md} className="animate-spin" /> : <ArrowRight size={ICON.md} />}
                data-testid="fetch-playlist-btn"
              >
                {isLoading ? 'Читаем…' : 'Разобрать ссылку'}
              </Button>
            </div>
          </form>
        )}

        {step === 'input' && (
          <SpotifyLibraryBlock
            onPicked={(title, items) => {
              setPreview({
                title,
                items,
                readyTracks: [],
                origin: { kind: 'platform', platform: 'spotify' }
              });
              setStep('preview');
            }}
          />
        )}

        {/* Step 2: Preview Parsed Playlist */}
        {step === 'preview' && preview && (
          /*
           * Шаги со второго по четвёртый выпадают при смене — каждый приходит
           * ответом на нажатие, и без движения переход читался подменой
           * содержимого окна, а не продвижением по шагам. Первый шаг нарочно
           * без класса: он появляется вместе с самим окном, и второе появление
           * поверх входа окна складывалось бы с ним.
           */
          <div className="animate-drop-in stack gap-4">
            <div
              className="row gap-3 p-3 radius-md bg-surface-3 border-subtle"
            >
              <div
                className="radius-sm row justify-center shrink-0 bg-surface-2" style={{ width: '48px', height: '48px' }}
              >
                {preview.coverUrl ? (
                  <img
                    src={preview.coverUrl}
                    alt={preview.title}
                    className="fill-cover radius-sm"
                  />
                ) : (
                  <Music size={ICON.xl} className="text-faint" />
                )}
              </div>

              <div className="grow">
                <div className="row gap-2">
                  <h4
                    className="text-truncate m-0 text-base weight-semibold text-primary"
                    data-testid="preview-playlist-title"
                  >
                    {preview.title}
                  </h4>
                  {preview.origin.kind === 'platform' ? (
                    <span
                      className="radius-xs text-xs weight-semibold" style={{ padding: '2px 6px', backgroundColor: PLATFORM_CONFIG[preview.origin.platform].bg, color: PLATFORM_CONFIG[preview.origin.platform].color }}
                    >
                      {PLATFORM_CONFIG[preview.origin.platform].name}
                    </span>
                  ) : (
                    <span
                      style={{ padding: '2px 6px', maxWidth: '190px' }}
                      className="text-truncate inline-row radius-xs text-secondary text-xs weight-semibold gap-1 bg-surface-2"
                      data-testid="preview-file-badge"
                    >
                      <FileText size={ICON.xs} aria-hidden="true" />
                      {preview.origin.filename}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted mt-px">
                  Найдено {pluralize(previewCount, 'трек', 'трека', 'треков')}
                  {preview.readyTracks.length > 0 && preview.items.length > 0 && (
                    <> · {preview.readyTracks.length} уже готовы к прослушиванию</>
                  )}
                </div>
              </div>
            </div>

            {/* Track list preview */}
            <div>
              <div className="text-xs text-secondary mb-2">
                Список треков ({previewCount}):
              </div>
              <div
                className="scrollbar-thin radius-md p-1 border-subtle bg-surface-2"
                style={{ maxHeight: '220px', overflowY: 'auto' }}
                data-testid="preview-track-list"
              >
                {[
                  ...preview.readyTracks.map((track) => ({
                    title: track.title,
                    artist: track.artist,
                    duration: track.duration
                  })),
                  ...preview.items
                ].map((item, idx, all) => (
                  <div
                    key={idx}
                    className="row justify-between text-sm py-2 px-3" style={{ borderBottom: idx < all.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
                  >
                    <div className="row gap-2 grow">
                      <span className="text-muted text-xs" style={{ width: '20px' }}>
                        {idx + 1}
                      </span>
                      <div className="text-truncate">
                        <span className="text-primary weight-medium">{item.title}</span>
                        <span className="text-secondary ml-2">
                          — {item.artist || UNKNOWN_ARTIST}
                        </span>
                      </div>
                    </div>
                    {item.duration ? (
                      <span data-numeric className="text-muted text-xs shrink-0">
                        {formatDuration(item.duration)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="row justify-between mt-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<RotateCcw size={ICON.sm} />}
                onClick={() => {
                  setPreview(null);
                  setMatches([]);
                  setStep('input');
                }}
              >
                Другой источник
              </Button>

              <div className="row-stretch gap-2">
                <Button variant="ghost" onClick={onClose}>
                  Отмена
                </Button>
                <Button
                  variant="primary"
                  icon={<Import size={ICON.md} />}
                  onClick={handleStartResolution}
                  data-testid="start-import-btn"
                >
                  {preview.items.length === 0
                    ? `Перенести (${previewCount})`
                    : `Найти и перенести (${previewCount})`}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Resolving Parallel Batch Search */}
        {step === 'resolving' && (
          <div className="animate-drop-in stack gap-4 py-3 px-0">
            <div className="text-center">
              <div
                className="inline-row justify-center mb-3 bg-accent-soft" style={{ width: '56px', height: '56px', borderRadius: '50%' }}
              >
                <Loader2 size={ICON['2xl']} className="animate-spin text-accent" />
              </div>
              <h4 className="m-0 text-lg text-primary weight-semibold">
                Ищем треки по источникам…
              </h4>
              <p className="text-sm text-secondary" style={{ margin: 'var(--space-1) 0 0 0' }}>
                Сверяем название, исполнителя и длительность — чтобы не подсунуть чужую версию
              </p>
            </div>

            {/* Live Progress Bar */}
            <div>
              <div className="row-stretch justify-between text-xs text-secondary mb-1">
                <span>
                  Обработано {progress.resolved} из {progress.total}
                </span>
                <span className="weight-semibold text-accent">{percentComplete}%</span>
              </div>
              <div
                className="w-full radius-full overflow-hidden bg-surface-3" style={{ height: '8px' }}
                data-testid="import-progress-bar-container"
              >
                <div
                  style={{
                    width: `${percentComplete}%`,
                    height: '100%',
                    backgroundColor: 'var(--accent)',
                    borderRadius: 'var(--radius-full)',
                    // Токены вместо 0.2s ease: у полосы импорта и полосы
                    // обновления в AboutSettings была разная длительность на
                    // одинаковом по смыслу движении.
                    transition: 'width var(--dur-normal) var(--ease-out)'
                  }}
                  data-testid="import-progress-bar-fill"
                />
              </div>
            </div>

            {progress.current && (
              <div
                className="text-truncate radius-sm text-xs text-secondary row gap-2 py-2 px-3 bg-surface-2"
                data-testid="current-resolving-track"
              >
                <Music size={ICON.sm} className="text-secondary shrink-0" />
                <span>Сейчас ищем: <strong className="text-primary">{progress.current}</strong></span>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Import Complete */}
        {step === 'complete' && preview && (
          <div className="animate-drop-in stack gap-4 py-2 px-0">
            <div className="text-center">
              <div
                className="inline-row justify-center bg-success-soft" style={{ width: '60px', height: '60px', borderRadius: '50%', margin: '0 auto var(--space-3) auto' }}
              >
                <CheckCircle2 size={ICON.display} className="text-success" />
              </div>

              <h4 className="m-0 text-lg text-primary weight-semibold">
                Готово!
              </h4>
              <p className="text-sm text-secondary" style={{ margin: 'var(--space-1) 0 0 0' }}>
                В плейлист «<strong>{preview.title}</strong>» перенесено треков: <strong>{resolvedTracks.length}</strong>
                {unmatched.length > 0 && <> из {matches.length + preview.readyTracks.length}</>}.
              </p>
            </div>

            {/* Отчёт о ненайденном: раньше эти строки просто исчезали */}
            {unmatched.length > 0 && (
              <div
                className="radius-md overflow-hidden border-subtle bg-surface-2"
                data-testid="import-unmatched-list"
              >
                <div
                  className="row gap-2 text-xs text-secondary py-2 px-3 border-b-subtle"
                >
                  <AlertCircle size={ICON.sm} className="text-warning" />
                  <span>
                    Не нашли уверенного совпадения: {pluralize(unmatched.length, 'трек', 'трека', 'треков')}. Можно выбрать вручную.
                  </span>
                </div>

                <div className="scrollbar-thin" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                  {unmatched.map(({ match, index }) => {
                    const state = manual[index];
                    return (
                      <div
                        key={index}
                        className="py-2 px-3 border-b-subtle"
                        data-testid={`import-unmatched-row-${index}`}
                      >
                        <div className="row gap-2">
                          <div className="grow">
                            <div className="text-truncate text-sm text-primary">
                              {match.item.title}
                              <span className="text-secondary ml-2">
                                — {match.item.artist || UNKNOWN_ARTIST}
                              </span>
                            </div>
                            {match.notes.length > 0 && (
                              <div className="text-xs text-muted mt-px">
                                {match.notes.join(' · ')}
                              </div>
                            )}
                          </div>

                          {state?.addedId ? (
                            <span
                              className="inline-row text-xs text-success shrink-0 gap-1"
                              data-testid={`import-manual-added-${index}`}
                            >
                              <Check size={ICON.xs} /> Добавлен
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={
                                state?.isSearching ? (
                                  <Loader2 size={ICON.xs} className="animate-spin" />
                                ) : (
                                  <Search size={ICON.xs} />
                                )
                              }
                              disabled={state?.isSearching}
                              onClick={() => void handleManualSearch(index)}
                              data-testid={`import-manual-search-${index}`}
                            >
                              Выбрать вручную
                            </Button>
                          )}
                        </div>

                        {!state?.addedId && state?.candidates && (
                          <div
                            // Список кандидатов раскрывается под кнопкой «Выбрать
                            // вручную» — то самое «нажал, и раскрылось».
                            className="animate-drop-in mt-2 stack gap-px"
                          >
                            {state.candidates.length === 0 ? (
                              <span className="text-xs text-muted">
                                Источники ничего не вернули по этому названию.
                              </span>
                            ) : (
                              state.candidates.map((candidate) => (
                                <button
                                  type="button"
                                  key={candidate.id}
                                  className="menu-item-hover w-full text-left"
                                  onClick={() => void handlePickCandidate(index, candidate)}
                                  data-testid={`import-manual-candidate-${index}-${candidate.id}`}
                                >
                                  <Music size={ICON.xs} aria-hidden="true" className="shrink-0" />
                                  <span className="text-truncate text-xs">
                                    {candidate.artist || UNKNOWN_ARTIST} — {candidate.title}
                                    {candidate.duration ? ` · ${formatDuration(candidate.duration)}` : ''}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {remembered.length > 0 && (
              <div
                className="radius-md overflow-hidden border-subtle bg-surface-2"
                data-testid="import-remembered-list"
              >
                <div
                  className="row gap-2 text-xs text-secondary py-2 px-3 border-b-subtle"
                >
                  <Check size={ICON.sm} className="text-success" />
                  <span>
                    {pluralize(remembered.length, 'трек взят', 'трека взяты', 'треков взяты')} по прошлым
                    подтверждениям. Если запись не та — забудьте выбор.
                  </span>
                </div>

                <div className="scrollbar-thin" style={{ maxHeight: '200px', overflowY: 'auto' }}>
                  {remembered.map(({ match, index }) => (
                    <div
                      key={index}
                      className="row gap-2 py-2 px-3 border-b-subtle"
                      data-testid={`import-remembered-row-${index}`}
                    >
                      <div className="grow">
                        <div className="text-truncate text-sm">
                          {match.item.title}
                        </div>
                        <div
                          className="text-truncate text-xs text-muted"
                        >
                          {match.track?.title} — {match.track?.artist}
                          {match.fromLink === 'manual' ? ' · выбрано вами' : ' · найдено раньше'}
                        </div>
                      </div>
                      {forgotten[index] ? (
                        <span className="text-xs text-muted shrink-0">
                          Забыто
                        </span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleForgetLink(index)}
                          data-testid={`import-forget-link-${index}`}
                        >
                          Забыть выбор
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="row-stretch justify-center gap-3 mt-2">
              <Button variant="ghost" onClick={onClose} data-testid="import-done-btn">
                Закрыть
              </Button>
              <Button
                variant="primary"
                icon={<Play size={ICON.md} />}
                onClick={handleOpenCreatedPlaylist}
                data-testid="open-imported-playlist-btn"
              >
                Открыть плейлист
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default ImportPlaylistModal;
