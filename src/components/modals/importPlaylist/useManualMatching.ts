import { useState, useCallback } from 'react';
import type { ImportMatch } from '../../../services/playlistImporter';
import { rankCandidates } from '../../../services/trackMatching';
import { forgetLink, rememberLink } from '../../../services/matchLinks';
import { searchAggregator } from '../../../services/aggregator';
import type { UnifiedTrack } from '../../../types/music';
import { useUIStore } from '../../../store/useUIStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import type { ManualState } from './types';

interface Options {
  matches: ImportMatch[];
  /** Плейлист, в который добавляется ручной выбор; до сохранения его нет. */
  importedPlaylistId: string | null;
  /** Добавленный вручную трек считается перенесённым — счётчик «Готово» растёт. */
  onTrackAdded: (track: UnifiedTrack) => void;
}

/**
 * Ручная доводка отчёта на последнем шаге: подбор для ненайденных строк и
 * отказ от подтверждённых соответствий.
 *
 * Живёт отдельно от хода переноса, потому что ничего из него не меняет —
 * только добавляет треки в уже созданный плейлист и правит память
 * подтверждений.
 */
export function useManualMatching({ matches, importedPlaylistId, onTrackAdded }: Options) {
  const showToast = useUIStore((s) => s.showToast);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);

  const [manual, setManual] = useState<Record<number, ManualState>>({});
  const [forgotten, setForgotten] = useState<Record<number, boolean>>({});

  const reset = useCallback(() => setManual({}), []);

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

      onTrackAdded(track);
      setManual((prev) => ({
        ...prev,
        [index]: { candidates: prev[index]?.candidates ?? null, isSearching: false, addedId: track.id }
      }));
      showToast(`«${track.title}» добавлен в плейлист`, 'success');
    },
    [addTrackToPlaylist, importedPlaylistId, matches, onTrackAdded, showToast]
  );

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

  return { manual, forgotten, reset, handleManualSearch, handlePickCandidate, handleForgetLink };
}
