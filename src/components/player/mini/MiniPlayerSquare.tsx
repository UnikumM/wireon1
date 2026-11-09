import React, { useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, ThumbsDown, Infinity as InfinityIcon, Loader2, Music2 } from 'lucide-react';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useUIStore } from '../../../store/useUIStore';
import { AudioVisualizer } from '../AudioVisualizer';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';

/**
 * Квадратный вид: вся обвязка лежит прямо на обложке.
 *
 * Поэтому цвета берутся из семейства `--on-media-*`, а не из обычных токенов
 * поверхности. Под фотографией нет «поверхности приложения», есть чужая
 * картинка: `--text-primary` на светлой теме почти чёрный, а `--glass-bg` —
 * белый, и пилюля управления стала бы белой с белыми же иконками внутри.
 * Семейство «поверх медиа» тему нарочно не слушает — белое остаётся белым при
 * любом оформлении, — зато лежит в одном месте, и подправить читаемость поверх
 * обложек можно сразу во всём приложении.
 */
export const MiniPlayerSquare: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);

  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const dislikeAndSkipCurrentTrack = usePlayerStore((s) => s.dislikeAndSkipCurrentTrack);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);

  const miniPlayerShowVisualizer = useUIStore((s) => s.miniPlayerShowVisualizer);
  const miniPlayerShowProgress = useUIStore((s) => s.miniPlayerShowProgress);

  const favorites = useLibraryStore((s) => s.favorites);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const isFav = currentTrack ? favorites.some((f) => f.id === currentTrack.id) : false;

  const [isHovered, setIsHovered] = useState(false);

  const showPause = isPlaying && !isLoading;
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    seekTo(ratio * duration);
  };

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative w-full h-full stack justify-between overflow-hidden" style={{ userSelect: 'none' }}
      data-testid="mini-player-square"
    >
      {/* Background artwork */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: currentTrack?.artworkUrl ? `url(${currentTrack.artworkUrl})` : 'none',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundColor: 'var(--surface-2)',
          filter: 'brightness(0.75)',
          transform: isHovered ? 'scale(1.04)' : 'scale(1)',
          // Токены, а не 0.4s ease: 400 мс — вдвое дольше самого медленного
          // перехода в системе (--dur-slow, 250), и наезд обложки заметно
          // отстаёт от кнопок, всплывающих над ней. Плюс `ease` — не та кривая:
          // в theme.css её нет ни у одного состояния.
          transition: 'transform var(--dur-slow) var(--ease-out)'
        }}
      >
        {!currentTrack?.artworkUrl && (
          <div className="w-full h-full row justify-center text-faint">
            <Music2 size={ICON.hero} />
          </div>
        )}
      </div>

      {/* Gradient vignette overlay */}
      <div
        className="no-events" style={{ position: 'absolute', inset: 0, background: 'var(--on-media-vignette)' }}
      />

      {/* Top track info */}
      <div
        className="relative row-start justify-between" style={{ zIndex: 2, padding: '12px 14px' }}
      >
        <div className="grow" style={{ textShadow: 'var(--text-shadow-md)' }}>
          <div
            className="text-truncate text-base weight-bold"
            style={{ color: 'var(--on-media)', lineHeight: 1.2 }}
            title={currentTrack?.title || 'Ничего не играет'}
          >
            {currentTrack?.title || 'Ничего не играет'}
          </div>
          <div
            className="text-truncate text-xs mt-px"
            style={{ color: 'var(--on-media-secondary)' }}
            title={currentTrack?.artist || 'Выберите трек'}
          >
            {currentTrack?.artist || 'Выберите трек'}
          </div>
        </div>

        {miniPlayerShowVisualizer && (
          <div className="shrink-0" style={{ width: '48px', height: '24px', opacity: 0.9 }}>
            <AudioVisualizer preset={visualizerPreset} width={48} height={24} />
          </div>
        )}
      </div>

      {/* Bottom Transport Panel */}
      <div
        className="relative stack gap-2" style={{ zIndex: 2, padding: '12px 14px' }}
      >
        {/* Progress & Time */}
        {miniPlayerShowProgress && (
          <div>
            <div
              onClick={handleProgressBarClick}
              className="relative w-full radius-full pointer overflow-hidden" style={{ height: '4px', backgroundColor: 'var(--on-media-border)' }}
              data-testid="mini-square-progress-bar"
            >
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
            <div className="row-stretch justify-between text-xs" style={{ color: 'var(--on-media-secondary)', marginTop: '3px' }}>
              <span data-numeric>{formatDuration(currentTime)}</span>
              <span data-numeric>{formatDuration(duration)}</span>
            </div>
          </div>
        )}

        {/* Controls Pill */}
        <div
          className="row justify-between radius-full" style={{ padding: '6px 12px', backgroundColor: 'var(--on-media-panel)', backdropFilter: 'blur(16px)', border: '1px solid var(--on-media-border)', boxShadow: 'var(--shadow-lg)' }}
        >
          {/* Like */}
          <button
            type="button"
            onClick={() => currentTrack && toggleFavorite(currentTrack)}
            className="pointer row bg-none border-none p-1" style={{ color: isFav ? 'var(--accent)' : 'var(--on-media-secondary)' }}
            title={isFav ? 'В любимом' : 'Добавить в любимое'}
            data-testid="mini-square-fav-btn"
          >
            <Heart size={ICON.md} fill={isFav ? 'currentColor' : 'none'} />
          </button>

          {/* Dislike */}
          <button
            type="button"
            onClick={() => void dislikeAndSkipCurrentTrack()}
            className="pointer row bg-none border-none p-1" style={{ color: 'var(--on-media-secondary)' }}
            title="Не рекомендовать (Дизлайк)"
            data-testid="mini-square-dislike-btn"
          >
            <ThumbsDown size={ICON.md} />
          </button>

          {/* Prev */}
          <button
            type="button"
            onClick={() => prevTrack()}
            className="pointer row bg-none border-none p-1" style={{ color: 'var(--on-media)' }}
            title="Предыдущий трек"
            data-testid="mini-square-prev-btn"
          >
            <SkipBack size={ICON.lg} />
          </button>

          {/* Play/Pause */}
          <button
            type="button"
            onClick={() => togglePlayPause()}
            className="control-lg radius-full pointer row justify-center bg-accent border-none" style={{ color: 'var(--text-on-accent)', boxShadow: 'var(--shadow-md)' }}
            title={showPause ? 'Пауза' : 'Играть'}
            data-testid="mini-square-play-btn"
          >
            {isLoading ? (
              <Loader2 className="animate-spin" size={ICON.lg} />
            ) : showPause ? (
              <Pause size={ICON.lg} />
            ) : (
              <Play size={ICON.lg} style={{ marginLeft: '1px' }} />
            )}
          </button>

          {/* Next */}
          <button
            type="button"
            onClick={() => nextTrack(true)}
            className="pointer row bg-none border-none p-1" style={{ color: 'var(--on-media)' }}
            title="Следующий трек"
            data-testid="mini-square-next-btn"
          >
            <SkipForward size={ICON.lg} />
          </button>

          {/* Radio */}
          <button
            type="button"
            onClick={() => setAutoplayRadio(!autoplayRadio)}
            className="pointer row bg-none border-none p-1" style={{ color: autoplayRadio ? 'var(--accent)' : 'var(--on-media-secondary)' }}
            title={autoplayRadio ? 'Автопоток включён' : 'Автопоток выключен'}
            data-testid="mini-square-radio-btn"
          >
            <InfinityIcon size={ICON.md} />
          </button>
        </div>
      </div>
    </div>
  );
};
