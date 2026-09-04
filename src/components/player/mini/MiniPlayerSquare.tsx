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
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        overflow: 'hidden',
        userSelect: 'none'
      }}
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
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)' }}>
            <Music2 size={ICON.hero} />
          </div>
        )}
      </div>

      {/* Gradient vignette overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.1) 40%, rgba(0,0,0,0.85) 100%)',
          pointerEvents: 'none'
        }}
      />

      {/* Top track info */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '12px 14px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start'
        }}
      >
        <div style={{ minWidth: 0, flex: 1, textShadow: 'var(--text-shadow-md)' }}>
          <div
            className="text-truncate"
            style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-bold)', color: 'var(--on-media)', lineHeight: 1.2 }}
            title={currentTrack?.title || 'Ничего не играет'}
          >
            {currentTrack?.title || 'Ничего не играет'}
          </div>
          <div
            className="text-truncate"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--on-media-secondary)', marginTop: '2px' }}
            title={currentTrack?.artist || 'Выберите трек'}
          >
            {currentTrack?.artist || 'Выберите трек'}
          </div>
        </div>

        {miniPlayerShowVisualizer && (
          <div style={{ width: '48px', height: '24px', flexShrink: 0, opacity: 0.9 }}>
            <AudioVisualizer preset={visualizerPreset} width={48} height={24} />
          </div>
        )}
      </div>

      {/* Bottom Transport Panel */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px'
        }}
      >
        {/* Progress & Time */}
        {miniPlayerShowProgress && (
          <div>
            <div
              onClick={handleProgressBarClick}
              style={{
                position: 'relative',
                width: '100%',
                height: '4px',
                backgroundColor: 'var(--on-media-border)',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
                overflow: 'hidden'
              }}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--on-media-secondary)', marginTop: '3px' }}>
              <span data-numeric>{formatDuration(currentTime)}</span>
              <span data-numeric>{formatDuration(duration)}</span>
            </div>
          </div>
        )}

        {/* Controls Pill */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            backgroundColor: 'var(--on-media-panel)',
            backdropFilter: 'blur(16px)',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--on-media-border)',
            boxShadow: 'var(--shadow-lg)'
          }}
        >
          {/* Like */}
          <button
            type="button"
            onClick={() => currentTrack && toggleFavorite(currentTrack)}
            style={{
              background: 'none',
              border: 'none',
              color: isFav ? 'var(--accent)' : 'var(--on-media-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center'
            }}
            title={isFav ? 'В любимом' : 'Добавить в любимое'}
            data-testid="mini-square-fav-btn"
          >
            <Heart size={ICON.md} fill={isFav ? 'currentColor' : 'none'} />
          </button>

          {/* Dislike */}
          <button
            type="button"
            onClick={() => void dislikeAndSkipCurrentTrack()}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--on-media-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center'
            }}
            title="Не рекомендовать (Дизлайк)"
            data-testid="mini-square-dislike-btn"
          >
            <ThumbsDown size={ICON.md} />
          </button>

          {/* Prev */}
          <button
            type="button"
            onClick={() => prevTrack()}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--on-media)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center'
            }}
            title="Предыдущий трек"
            data-testid="mini-square-prev-btn"
          >
            <SkipBack size={ICON.lg} />
          </button>

          {/* Play/Pause */}
          <button
            type="button"
            onClick={() => togglePlayPause()}
            style={{
              width: 'var(--control-lg)',
              height: 'var(--control-lg)',
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              color: 'var(--text-on-accent)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: 'var(--shadow-md)'
            }}
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
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--on-media)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center'
            }}
            title="Следующий трек"
            data-testid="mini-square-next-btn"
          >
            <SkipForward size={ICON.lg} />
          </button>

          {/* Radio */}
          <button
            type="button"
            onClick={() => setAutoplayRadio(!autoplayRadio)}
            style={{
              background: 'none',
              border: 'none',
              color: autoplayRadio ? 'var(--accent)' : 'var(--on-media-secondary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center'
            }}
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
