import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { playlistImporter, ImportMatch } from '../../../services/playlistImporter';
import { PlaylistFileError } from '../../../services/playlistTransfer';
import type { UnifiedTrack } from '../../../types/music';
import { useUIStore } from '../../../store/useUIStore';
import { pluralize } from '../../../utils/plural';
import { PLATFORM_CONFIG } from './platforms';
import { readPlaylistFile, readPlaylistLink } from './readSources';
import type { ImportPlaylistModalProps, ImportStep, IndexedMatch, PreviewState, ResolveProgress } from './types';
import { useManualMatching } from './useManualMatching';

/**
 * Весь ход переноса: ссылка или файл → предпросмотр → поиск → отчёт.
 *
 * Окно само ничего не решает — только показывает шаг и дёргает обработчики
 * отсюда. Так шаги остаются чистой разметкой, а последовательность и сбросы
 * собраны в одном месте.
 */
export function useImportFlow({ isOpen, onClose, onImported }: ImportPlaylistModalProps) {
  const showToast = useUIStore((s) => s.showToast);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);

  const [url, setUrl] = useState('');
  const [step, setStep] = useState<ImportStep>('input');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [resolvedTracks, setResolvedTracks] = useState<UnifiedTrack[]>([]);
  const [matches, setMatches] = useState<ImportMatch[]>([]);
  const [progress, setProgress] = useState<ResolveProgress>({ resolved: 0, total: 0 });
  const [importedPlaylistId, setImportedPlaylistId] = useState<string | null>(null);

  const appendResolvedTrack = useCallback((track: UnifiedTrack) => {
    setResolvedTracks((prev) => [...prev, track]);
  }, []);
  const manual = useManualMatching({ matches, importedPlaylistId, onTrackAdded: appendResolvedTrack });
  const resetManual = manual.reset;

  // Площадка подсвечивается по мере набора ссылки
  const detectedPlatform = useMemo(() => {
    if (!url.trim()) return null;
    return playlistImporter.detectPlatform(url);
  }, [url]);

  /** Ненайденные строки вместе с их номером — номер нужен для ручного выбора. */
  const unmatched = useMemo<IndexedMatch[]>(
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
  const remembered = useMemo<IndexedMatch[]>(
    () => matches.map((match, index) => ({ match, index })).filter((entry) => entry.match.fromLink),
    [matches]
  );

  // Сброс после закрытия — с задержкой, чтобы шаг не сменился поверх анимации ухода
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
        resetManual();
        setProgress({ resolved: 0, total: 0 });
        setImportedPlaylistId(null);
      }, 200);
    }
  }, [isOpen, resetManual]);

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (error) setError(null);
  };

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
      setPreview(await readPlaylistLink(trimmed));
      setStep('preview');
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать плейлист. Проверьте ссылку и попробуйте снова.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChosen = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Сбрасываем сразу, иначе повторный выбор того же файла не даст события.
    event.target.value = '';
    if (!file) return;

    setIsLoading(true);
    setError(null);

    try {
      setPreview(await readPlaylistFile(file));
      setStep('preview');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(err instanceof PlaylistFileError ? detail : `Не удалось прочитать файл: ${detail}`);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /** Список из Spotify после входа — сразу на предпросмотр, разбирать нечего. */
  const handleSpotifyPicked = (title: string, items: PreviewState['items']) => {
    setPreview({
      title,
      items,
      readyTracks: [],
      origin: { kind: 'platform', platform: 'spotify' }
    });
    setStep('preview');
  };

  const handleBackToInput = () => {
    setPreview(null);
    setMatches([]);
    setStep('input');
  };

  const handleStartResolution = async () => {
    if (!preview) return;
    if (preview.items.length === 0 && preview.readyTracks.length === 0) return;

    setStep('resolving');
    setIsLoading(true);
    setError(null);
    setMatches([]);
    resetManual();
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

  return {
    url,
    step,
    isLoading,
    error,
    preview,
    previewCount,
    detectedPlatform,
    resolvedTracks,
    matches,
    unmatched,
    remembered,
    progress,
    percentComplete,
    manual: manual.manual,
    forgotten: manual.forgotten,
    handleUrlChange,
    handleFetchMetadata,
    handleFileChosen,
    handleSpotifyPicked,
    handleBackToInput,
    handleStartResolution,
    handleManualSearch: manual.handleManualSearch,
    handlePickCandidate: manual.handlePickCandidate,
    handleForgetLink: manual.handleForgetLink,
    handleOpenCreatedPlaylist
  };
}
