import React, { useMemo, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { Button } from '../common/Button';
import { SourceBadge } from '../common/SourceBadge';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { chooseBetterDuplicate, DuplicatePair, findDuplicatePairs } from '../../services/trackMatching';
import { getQuality, describeQuality } from '../../services/trackQuality';
import type { UnifiedTrack } from '../../types/music';
import { formatDuration } from '../../utils/time';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface DuplicatesBannerProps {
  /** Полное избранное — не отфильтрованное: дубли ищутся по всему списку. */
  tracks: ReadonlyArray<UnifiedTrack>;
  className?: string;
}

/** Одна запись пары: обложка, название, бейдж источника, длительность. */
const PairSide: React.FC<{ track: UnifiedTrack }> = ({ track }) => {
  const quality = getQuality(track.id);
  return (
    <div className="row gap-3 min-0 grow" data-testid={`duplicate-side-${track.id}`}>
      {track.artworkUrl ? (
        <img src={track.artworkUrl} alt="" className="duplicate-art shrink-0 radius-sm" />
      ) : (
        <span className="duplicate-art shrink-0 radius-sm bg-surface-3" aria-hidden="true" />
      )}
      <div className="stack gap-1 min-0 grow">
        <span className="text-truncate text-sm weight-medium text-primary">{track.title}</span>
        <span className="row gap-2 text-xs text-muted">
          <SourceBadge source={track.source} size="xs" />
          <span className="text-truncate">{track.artist}</span>
          {track.duration > 0 && <span data-numeric className="shrink-0">{formatDuration(track.duration)}</span>}
          {quality && (
            <span className="shrink-0 text-warning" title={describeQuality(quality).title}>
              {describeQuality(quality).label}
            </span>
          )}
        </span>
      </div>
    </div>
  );
};

/**
 * «Нашли N пар одинаковых треков с YouTube и SoundCloud» над «Избранным».
 *
 * Одна и та же песня попадает в избранное дважды, когда её нашли с разных
 * площадок: в списке это две строки, в очереди — два включения подряд. Плашка
 * предлагает убрать одну, но решение остаётся за человеком: пара показывается
 * целиком, с бейджами и пометками качества, и кнопки говорят, что именно
 * останется. Закрытая плашка не возвращается до следующего захода в раздел —
 * состояние нарочно локальное.
 */
export const DuplicatesBanner: React.FC<DuplicatesBannerProps> = ({ tracks, className = '' }) => {
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const showToast = useUIStore((s) => s.showToast);
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  const pairs = useMemo(() => findDuplicatePairs(tracks), [tracks]);

  if (dismissed || pairs.length === 0) return null;

  const remove = async (drop: UnifiedTrack): Promise<boolean> => {
    // В избранном трек точно есть — toggle его убирает. Если его уже убрали с
    // другого устройства, toggle вернул бы его обратно, поэтому проверяем.
    if (!useLibraryStore.getState().isFavorite(drop.id)) return false;
    return toggleFavorite(drop);
  };

  const handleKeep = async (pair: DuplicatePair, keep: 'youtube' | 'soundcloud') => {
    const drop = keep === 'youtube' ? pair.soundcloud : pair.youtube;
    const ok = await remove(drop);
    showToast(
      ok
        ? `Оставили ${keep === 'youtube' ? 'YouTube' : 'SoundCloud'}: «${pair.youtube.title}»`
        : 'Не удалось убрать из избранного',
      ok ? 'success' : 'error'
    );
  };

  const handleMergeAll = async () => {
    let removed = 0;
    for (const pair of pairs) {
      const { drop } = chooseBetterDuplicate(pair, getQuality);
      if (await remove(drop)) removed += 1;
    }
    showToast(
      removed > 0
        ? `Объединили ${pluralize(removed, 'пару', 'пары', 'пар')}, остались лучшие записи`
        : 'Не удалось убрать дубли из избранного',
      removed > 0 ? 'success' : 'error'
    );
  };

  return (
    <section
      className={`duplicates-banner stack gap-3 ${className}`.trim()}
      aria-label="Одинаковые треки с разных источников"
      data-testid="duplicates-banner"
    >
      <div className="row gap-3 wrap">
        <span className="duplicates-banner-icon row justify-center shrink-0" aria-hidden="true">
          <Copy size={ICON.md} />
        </span>
        <p className="m-0 grow text-sm text-primary leading-sm" data-testid="duplicates-summary">
          Нашли {pluralize(pairs.length, 'пару', 'пары', 'пар')} одинаковых треков с YouTube и SoundCloud
        </p>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="duplicates-toggle">
          {open ? 'Скрыть' : 'Показать'}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          icon={<X size={ICON.sm} aria-hidden="true" />}
          onClick={() => setDismissed(true)}
          aria-label="Закрыть"
          title="Закрыть"
          data-testid="duplicates-dismiss"
        />
      </div>

      {open && (
        <div className="stack gap-3" data-testid="duplicates-list">
          {pairs.map((pair) => (
            <div key={`${pair.youtube.id}|${pair.soundcloud.id}`} className="duplicate-pair stack gap-2" data-testid="duplicate-pair">
              <div className="duplicate-pair-sides">
                <PairSide track={pair.youtube} />
                <PairSide track={pair.soundcloud} />
              </div>
              <div className="row gap-2 wrap">
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void handleKeep(pair, 'youtube')}
                  data-testid={`duplicate-keep-youtube-${pair.youtube.id}`}
                >
                  Оставить YouTube
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => void handleKeep(pair, 'soundcloud')}
                  data-testid={`duplicate-keep-soundcloud-${pair.soundcloud.id}`}
                >
                  Оставить SoundCloud
                </Button>
              </div>
            </div>
          ))}
          <div className="row">
            <Button variant="primary" size="sm" onClick={() => void handleMergeAll()} data-testid="duplicates-merge-all">
              Объединить всё: оставить лучший
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};
