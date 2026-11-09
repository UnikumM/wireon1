import React from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, Infinity as InfinityIcon, Loader2, Music2 } from 'lucide-react';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useUIStore } from '../../../store/useUIStore';
import { AudioVisualizer } from '../AudioVisualizer';
import { ICON } from '../../../styles/icons';

export const MiniPlayerCompact: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);

  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);

  const miniPlayerShowVisualizer = useUIStore((s) => s.miniPlayerShowVisualizer);
  const miniPlayerShowProgress = useUIStore((s) => s.miniPlayerShowProgress);

  const favorites = useLibraryStore((s) => s.favorites);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const isFav = currentTrack ? favorites.some((f) => f.id === currentTrack.id) : false;

  const showPause = isPlaying && !isLoading;
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const bufferPercent = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    seekTo(ratio * duration);
  };

  return (
    <div
      className="stack h-full justify-between relative" style={{ padding: '8px 12px' }}
      data-testid="mini-player-compact"
    >
      <div className="row grow gap-3">
        {/* Cover Art */}
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            flexShrink: 0,
            position: 'relative',
            backgroundColor: 'var(--surface-3)',
            border: '1px solid var(--border)',
            // Тень обложки — из лестницы токенов: в светлой теме тени не
            // чёрные, а холодно-серые, и зашитый чёрный смотрелся бы грязным
            // пятном под картинкой.
            boxShadow: 'var(--shadow-md)'
          }}
        >
          {currentTrack?.artworkUrl ? (
            <img
              src={currentTrack.artworkUrl}
              alt={currentTrack.title}
              className="fill-cover"
            />
          ) : (
            <div className="w-full h-full row justify-center text-faint">
              <Music2 size={ICON.lg} />
            </div>
          )}
        </div>

        {/* Title & Artist */}
        <div className="grow stack gap-px">
          <div
            className="text-truncate text-sm weight-semibold text-primary"
            style={{ lineHeight: 1.2 }}
            title={currentTrack?.title || 'Ничего не играет'}
          >
            {currentTrack?.title || 'Ничего не играет'}
          </div>
          <div
            className="text-truncate text-xs text-secondary"
            style={{ lineHeight: 1.2 }}
            title={currentTrack?.artist || 'Выберите трек'}
          >
            {currentTrack?.artist || 'Выберите трек'}
          </div>
        </div>

        {/* Visualizer if enabled */}
        {miniPlayerShowVisualizer && (
          <div className="shrink-0" style={{ width: '42px', height: '26px', opacity: 0.85 }}>
            <AudioVisualizer preset={visualizerPreset} width={42} height={26} />
          </div>
        )}

        {/* Controls */}
        <div className="row shrink-0" style={{ gap: '6px' }}>
          {currentTrack && (
            <button
              type="button"
              onClick={() => toggleFavorite(currentTrack)}
              className="pointer row bg-none border-none p-1" style={{ color: isFav ? 'var(--accent)' : 'var(--text-muted)' }}
              title={isFav ? 'В любимом' : 'Добавить в любимое'}
              data-testid="mini-compact-fav-btn"
            >
              <Heart size={ICON.md} fill={isFav ? 'currentColor' : 'none'} />
            </button>
          )}

          <button
            type="button"
            onClick={() => prevTrack()}
            className="text-primary pointer row bg-none border-none p-1"
            title="Предыдущий трек"
            data-testid="mini-compact-prev-btn"
          >
            <SkipBack size={ICON.md} />
          </button>

          <button
            type="button"
            onClick={() => togglePlayPause()}
            className="control-md radius-full pointer row justify-center shrink-0 bg-accent border-none" style={{ color: 'var(--text-on-accent)', boxShadow: 'var(--shadow-sm)' }}
            title={showPause ? 'Пауза' : 'Играть'}
            data-testid="mini-compact-play-btn"
          >
            {isLoading ? (
              <Loader2 className="animate-spin" size={ICON.md} />
            ) : showPause ? (
              <Pause size={ICON.md} />
            ) : (
              <Play size={ICON.md} style={{ marginLeft: '1px' }} />
            )}
          </button>

          <button
            type="button"
            onClick={() => nextTrack(true)}
            className="text-primary pointer row bg-none border-none p-1"
            title="Следующий трек"
            data-testid="mini-compact-next-btn"
          >
            <SkipForward size={ICON.md} />
          </button>

          <button
            type="button"
            onClick={() => setAutoplayRadio(!autoplayRadio)}
            className="pointer row bg-none border-none p-1" style={{ color: autoplayRadio ? 'var(--accent)' : 'var(--text-muted)' }}
            title={autoplayRadio ? 'Автопоток включён' : 'Автопоток выключен'}
            data-testid="mini-compact-radio-btn"
          >
            <InfinityIcon size={ICON.md} />
          </button>
        </div>
      </div>

      {/* Progress timeline */}
      {miniPlayerShowProgress && (
        <div
          onClick={handleProgressBarClick}
          className="relative w-full radius-full pointer overflow-hidden" style={{ height: '4px', backgroundColor: 'var(--surface-active)', marginTop: '6px' }}
          data-testid="mini-compact-progress-bar"
        >
          {/* Buffer */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${bufferPercent}%`,
              // Загруженное показывается токеном границы, а не белым с альфой:
              // нужен нейтральный wash на ступень заметнее дорожки
              // (`--surface-active`), и только `--border-strong` держит это
              // соотношение в обе стороны — на светлой теме он темнеет вместе с
              // дорожкой, тогда как белая полупрозрачность просто исчезала.
              backgroundColor: 'var(--border-strong)',
              borderRadius: 'inherit'
            }}
          />
          {/* Progress */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${progressPercent}%`,
              backgroundColor: 'var(--accent)',
              borderRadius: 'inherit'
            }}
          />
        </div>
      )}
    </div>
  );
};
