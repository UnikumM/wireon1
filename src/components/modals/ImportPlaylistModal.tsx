import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
 * Фирменные цвета сервисов-источников.
 *
 * Единственные литералы, оставшиеся в файле, и намеренно: это опознавательный
 * знак чужого бренда, а не наш оттенок, — зелёный Spotify обязан остаться
 * зелёным Spotify при любой теме. Для YouTube и SoundCloud такие тона уже
 * приглушены до нашей пастели токенами `--badge-*` в theme.css; этим четырём
 * парных токенов пока нет, поэтому цвет лежит здесь. Как только они появятся,
 * значения отсюда уезжают в тему целиком.
 */
const PLATFORM_CONFIG: Record<PlatformType, PlatformBadgeConfig> = {
  spotify: {
    name: 'Spotify',
    color: '#1DB954',
    bg: 'rgba(29, 185, 84, 0.15)',
    border: 'rgba(29, 185, 84, 0.4)'
  },
  yandex: {
    name: 'Yandex Music',
    color: '#FC3F1D',
    bg: 'rgba(252, 63, 29, 0.15)',
    border: 'rgba(252, 63, 29, 0.4)'
  },
  vk: {
    name: 'VK Music',
    color: '#0077FF',
    bg: 'rgba(0, 119, 255, 0.15)',
    border: 'rgba(0, 119, 255, 0.4)'
  },
  apple: {
    name: 'Apple Music',
    color: '#FA243C',
    bg: 'rgba(250, 36, 60, 0.15)',
    border: 'rgba(250, 36, 60, 0.4)'
  }
};

/** `nochnaya-doroga-2026-08-18.wireon.json` → `nochnaya-doroga-2026-08-18`. */
function titleFromFilename(filename: string): string {
  return filename.replace(/\.(wireon\.)?[a-z0-9]{2,5}$/i, '').trim() || UNTITLED_PLAYLIST;
}

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

      setResolvedTracks((prev) => [...prev, track]);
      setManual((prev) => ({
        ...prev,
        [index]: { candidates: prev[index]?.candidates ?? null, isSearching: false, addedId: track.id }
      }));
      showToast(`«${track.title}» добавлен в плейлист`, 'success');
    },
    [addTrackToPlaylist, importedPlaylistId, showToast]
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {/* Значок переноса, а не звёздочки: окно ровно про перенос. */}
          <Import size={ICON.lg} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
          <span>Перенести плейлист</span>
        </div>
      }
      maxWidth="560px"
      data-testid="import-playlist-modal"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* Error Banner */}
        {error && (
          <div
            role="alert"
            // Отказ появляется в ответ на нажатие — и обязан быть замечен.
            className="animate-drop-in"
            style={{
              padding: 'var(--space-3) var(--space-4)',
              backgroundColor: 'var(--danger-soft)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--danger)',
              fontSize: 'var(--text-sm)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-2)'
            }}
            data-testid="import-error-banner"
          >
            <AlertCircle size={ICON.md} style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ flex: 1 }}>{error}</div>
          </div>
        )}

        {/* Step 1: Input URL */}
        {step === 'input' && (
          <form onSubmit={handleFetchMetadata} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div>
              <label
                htmlFor="import-url-input"
                style={{
                  display: 'block',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 'var(--weight-medium)',
                  color: 'var(--text-secondary)',
                  marginBottom: 'var(--space-2)'
                }}
              >
                Ссылка на плейлист или альбом
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  id="import-url-input"
                  type="url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="https://open.spotify.com/playlist/… либо Яндекс Музыка, VK, Apple Music"
                  autoFocus
                  style={{
                    width: '100%',
                    paddingRight: detectedPlatform ? '140px' : 'var(--space-3)'
                  }}
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
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
                Откуда можно переносить:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
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
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-3)',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px dashed var(--border-subtle)',
                backgroundColor: 'var(--surface-2)'
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>
                  Или откройте файл плейлиста
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
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

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
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

        {/* Step 2: Preview Parsed Playlist */}
        {step === 'preview' && preview && (
          /*
           * Шаги со второго по четвёртый выпадают при смене — каждый приходит
           * ответом на нажатие, и без движения переход читался подменой
           * содержимого окна, а не продвижением по шагам. Первый шаг нарочно
           * без класса: он появляется вместе с самим окном, и второе появление
           * поверх входа окна складывалось бы с ним.
           */
          <div className="animate-drop-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                padding: 'var(--space-3)',
                backgroundColor: 'var(--surface-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--surface-2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                {preview.coverUrl ? (
                  <img
                    src={preview.coverUrl}
                    alt={preview.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-sm)' }}
                  />
                ) : (
                  <Music size={ICON.xl} style={{ color: 'var(--text-faint)' }} />
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <h4
                    style={{
                      margin: 0,
                      fontSize: 'var(--text-base)',
                      fontWeight: 'var(--weight-semibold)',
                      color: 'var(--text-primary)'
                    }}
                    className="text-truncate"
                    data-testid="preview-playlist-title"
                  >
                    {preview.title}
                  </h4>
                  {preview.origin.kind === 'platform' ? (
                    <span
                      style={{
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-xs)',
                        backgroundColor: PLATFORM_CONFIG[preview.origin.platform].bg,
                        color: PLATFORM_CONFIG[preview.origin.platform].color,
                        fontSize: 'var(--text-xs)',
                        fontWeight: 'var(--weight-semibold)'
                      }}
                    >
                      {PLATFORM_CONFIG[preview.origin.platform].name}
                    </span>
                  ) : (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 6px',
                        borderRadius: 'var(--radius-xs)',
                        backgroundColor: 'var(--surface-2)',
                        color: 'var(--text-secondary)',
                        fontSize: 'var(--text-xs)',
                        fontWeight: 'var(--weight-semibold)',
                        maxWidth: '190px'
                      }}
                      className="text-truncate"
                      data-testid="preview-file-badge"
                    >
                      <FileText size={ICON.xs} aria-hidden="true" />
                      {preview.origin.filename}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
                  Найдено {pluralize(previewCount, 'трек', 'трека', 'треков')}
                  {preview.readyTracks.length > 0 && preview.items.length > 0 && (
                    <> · {preview.readyTracks.length} уже готовы к прослушиванию</>
                  )}
                </div>
              </div>
            </div>

            {/* Track list preview */}
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
                Список треков ({previewCount}):
              </div>
              <div
                className="scrollbar-thin"
                style={{
                  maxHeight: '220px',
                  overflowY: 'auto',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--surface-2)',
                  padding: 'var(--space-1)'
                }}
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
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: idx < all.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                      fontSize: 'var(--text-sm)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0, flex: 1 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', width: '20px' }}>
                        {idx + 1}
                      </span>
                      <div className="text-truncate">
                        <span style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>{item.title}</span>
                        <span style={{ color: 'var(--text-secondary)', marginLeft: 'var(--space-2)' }}>
                          — {item.artist || UNKNOWN_ARTIST}
                        </span>
                      </div>
                    </div>
                    {item.duration ? (
                      <span data-numeric style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', flexShrink: 0 }}>
                        {formatDuration(item.duration)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'var(--space-2)' }}>
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

              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
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
          <div className="animate-drop-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-3) 0' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-soft)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 'var(--space-3)'
                }}
              >
                <Loader2 size={ICON['2xl']} className="animate-spin" style={{ color: 'var(--accent)' }} />
              </div>
              <h4 style={{ margin: 0, fontSize: 'var(--text-lg)', color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>
                Ищем треки по источникам…
              </h4>
              <p style={{ margin: 'var(--space-1) 0 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                Сверяем название, исполнителя и длительность — чтобы не подсунуть чужую версию
              </p>
            </div>

            {/* Live Progress Bar */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 'var(--space-1)' }}>
                <span>
                  Обработано {progress.resolved} из {progress.total}
                </span>
                <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--accent)' }}>{percentComplete}%</span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: '8px',
                  backgroundColor: 'var(--surface-3)',
                  borderRadius: 'var(--radius-full)',
                  overflow: 'hidden'
                }}
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
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  backgroundColor: 'var(--surface-2)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)'
                }}
                className="text-truncate"
                data-testid="current-resolving-track"
              >
                <Music size={ICON.sm} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                <span>Сейчас ищем: <strong style={{ color: 'var(--text-primary)' }}>{progress.current}</strong></span>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Import Complete */}
        {step === 'complete' && preview && (
          <div className="animate-drop-in" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: 'var(--space-2) 0' }}>
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: '60px',
                  height: '60px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--success-soft)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto var(--space-3) auto'
                }}
              >
                <CheckCircle2 size={ICON.display} style={{ color: 'var(--success)' }} />
              </div>

              <h4 style={{ margin: 0, fontSize: 'var(--text-lg)', color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>
                Готово!
              </h4>
              <p style={{ margin: 'var(--space-1) 0 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                В плейлист «<strong>{preview.title}</strong>» перенесено треков: <strong>{resolvedTracks.length}</strong>
                {unmatched.length > 0 && <> из {matches.length + preview.readyTracks.length}</>}.
              </p>
            </div>

            {/* Отчёт о ненайденном: раньше эти строки просто исчезали */}
            {unmatched.length > 0 && (
              <div
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'var(--surface-2)',
                  overflow: 'hidden'
                }}
                data-testid="import-unmatched-list"
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderBottom: '1px solid var(--border-subtle)',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-secondary)'
                  }}
                >
                  <AlertCircle size={ICON.sm} style={{ color: 'var(--warning)' }} />
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
                        style={{
                          padding: 'var(--space-2) var(--space-3)',
                          borderBottom: '1px solid var(--border-subtle)'
                        }}
                        data-testid={`import-unmatched-row-${index}`}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="text-truncate" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                              {match.item.title}
                              <span style={{ color: 'var(--text-secondary)', marginLeft: 'var(--space-2)' }}>
                                — {match.item.artist || UNKNOWN_ARTIST}
                              </span>
                            </div>
                            {match.notes.length > 0 && (
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
                                {match.notes.join(' · ')}
                              </div>
                            )}
                          </div>

                          {state?.addedId ? (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                fontSize: 'var(--text-xs)',
                                color: 'var(--success)',
                                flexShrink: 0
                              }}
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
                            className="animate-drop-in"
                            style={{ marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: '2px' }}
                          >
                            {state.candidates.length === 0 ? (
                              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                                Источники ничего не вернули по этому названию.
                              </span>
                            ) : (
                              state.candidates.map((candidate) => (
                                <button
                                  type="button"
                                  key={candidate.id}
                                  className="menu-item-hover"
                                  onClick={() => void handlePickCandidate(index, candidate)}
                                  style={{ width: '100%', textAlign: 'left' }}
                                  data-testid={`import-manual-candidate-${index}-${candidate.id}`}
                                >
                                  <Music size={ICON.xs} aria-hidden="true" style={{ flexShrink: 0 }} />
                                  <span className="text-truncate" style={{ fontSize: 'var(--text-xs)' }}>
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

            <div style={{ display: 'flex', justifyContent: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-2)' }}>
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
