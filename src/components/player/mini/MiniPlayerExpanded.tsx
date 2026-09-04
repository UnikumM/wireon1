import React from 'react';
import { Play, Pause, SkipBack, SkipForward, Heart, ThumbsDown, Shuffle, Repeat, Repeat1, Infinity as InfinityIcon, Loader2, Music2, Volume2, VolumeX, ListMusic } from 'lucide-react';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useUIStore } from '../../../store/useUIStore';
import { AudioVisualizer } from '../AudioVisualizer';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';

/** Те же подписи, что и в основном плеере — чтобы окна не расходились. */
const REPEAT_LABEL: Record<string, string> = {
  off: 'выключен',
  all: 'вся очередь',
  one: 'один трек'
};

export const MiniPlayerExpanded: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);
  const visualizerPreset = usePlayerStore((s) => s.visualizerPreset);
  const userQueue = usePlayerStore((s) => s.userQueue);
  const sourceQueue = usePlayerStore((s) => s.sourceQueue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);

  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);
  const dislikeAndSkipCurrentTrack = usePlayerStore((s) => s.dislikeAndSkipCurrentTrack);

  const miniPlayerShowVisualizer = useUIStore((s) => s.miniPlayerShowVisualizer);

  const favorites = useLibraryStore((s) => s.favorites);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const isFav = currentTrack ? favorites.some((f) => f.id === currentTrack.id) : false;

  const showPause = isPlaying && !isLoading;
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const bufferPercent = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;

  // Next upcoming track peek
  const upcomingTrack = userQueue.length > 0
    ? userQueue[0]
    : currentIndex + 1 < sourceQueue.length
    ? sourceQueue[currentIndex + 1]
    : null;

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    seekTo(ratio * duration);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        justifyContent: 'space-between',
        padding: '12px 14px',
        overflowY: 'auto',
        gap: '10px'
      }}
      data-testid="mini-player-expanded"
    >
      {/* Top Track Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          style={{
            width: '56px',
            height: '56px',
            borderRadius: 'var(--radius-md)',
            overflow: 'hidden',
            flexShrink: 0,
            backgroundColor: 'var(--surface-3)',
            border: '1px solid var(--border)',
            // Тень обложки — токеном: в светлой теме тени холодно-серые, а не
            // чёрные, и литерал давал бы грязное пятно под картинкой.
            boxShadow: 'var(--shadow-md)'
          }}
        >
          {currentTrack?.artworkUrl ? (
            <img
              src={currentTrack.artworkUrl}
              alt={currentTrack.title}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)' }}>
              <Music2 size={ICON.xl} />
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="text-truncate"
            style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', lineHeight: 1.2 }}
            title={currentTrack?.title || 'Ничего не играет'}
          >
            {currentTrack?.title || 'Ничего не играет'}
          </div>
          <div
            className="text-truncate"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}
            title={currentTrack?.artist || 'Выберите трек'}
          >
            {currentTrack?.artist || 'Выберите трек'}
          </div>
        </div>

        <button
          type="button"
          onClick={() => currentTrack && toggleFavorite(currentTrack)}
          style={{
            background: 'none',
            border: 'none',
            color: isFav ? 'var(--accent)' : 'var(--text-muted)',
            cursor: 'pointer',
            padding: '6px',
            display: 'flex',
            alignItems: 'center'
          }}
          title={isFav ? 'В любимом' : 'Добавить в любимое'}
          data-testid="mini-expanded-fav-btn"
        >
          <Heart size={ICON.lg} fill={isFav ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Visualizer */}
      {miniPlayerShowVisualizer && (
        <div
          style={{
            height: '44px',
            width: '100%',
            // Колодец под визуализатор — самая нижняя ступень поверхностей:
            // канва рисует по нему свои цвета, поэтому фон обязан быть тише
            // окна в любой теме, а не чёрным поверх светлой панели.
            backgroundColor: 'var(--surface-sunken)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            border: '1px solid var(--border-subtle)'
          }}
        >
          <AudioVisualizer preset={visualizerPreset} width={310} height={44} />
        </div>
      )}

      {/* Seekbar & Timestamps */}
      <div>
        <div
          onClick={handleProgressBarClick}
          style={{
            position: 'relative',
            width: '100%',
            height: '5px',
            // Та же тройка, что в основном SeekBar: дорожка — утопленная
            // поверхность, загруженное — заметный нейтральный wash, играющее —
            // акцент. Литеральная белизна ломала первые две на светлой теме.
            backgroundColor: 'var(--surface-active)',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            overflow: 'hidden'
          }}
          data-testid="mini-expanded-progress-bar"
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: `${bufferPercent}%`,
              backgroundColor: 'var(--border-strong)',
              borderRadius: 'inherit'
            }}
          />
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
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>
          <span data-numeric>{formatDuration(currentTime)}</span>
          <span data-numeric>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Transport Controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px' }}>
        <button
          type="button"
          onClick={toggleShuffle}
          style={{
            background: 'none',
            border: 'none',
            color: isShuffled ? 'var(--accent)' : 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px'
          }}
          title={isShuffled ? 'Перемешивание: вкл' : 'Перемешивание: выкл'}
          data-testid="mini-expanded-shuffle-btn"
        >
          <Shuffle size={ICON.md} />
        </button>

        <button
          type="button"
          onClick={() => prevTrack()}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: '4px'
          }}
          title="Предыдущий трек"
          data-testid="mini-expanded-prev-btn"
        >
          <SkipBack size={ICON.lg} />
        </button>

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
          data-testid="mini-expanded-play-btn"
        >
          {isLoading ? (
            <Loader2 className="animate-spin" size={ICON.lg} />
          ) : showPause ? (
            <Pause size={ICON.lg} />
          ) : (
            <Play size={ICON.lg} style={{ marginLeft: '2px' }} />
          )}
        </button>

        <button
          type="button"
          onClick={() => nextTrack(true)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            padding: '4px'
          }}
          title="Следующий трек"
          data-testid="mini-expanded-next-btn"
        >
          <SkipForward size={ICON.lg} />
        </button>

        <button
          type="button"
          onClick={cycleRepeatMode}
          style={{
            background: 'none',
            border: 'none',
            color: repeatMode === 'off' ? 'var(--text-muted)' : 'var(--accent)',
            cursor: 'pointer',
            padding: '4px'
          }}
          title={`Повтор: ${REPEAT_LABEL[repeatMode]}`}
          data-testid="mini-expanded-repeat-btn"
        >
          {repeatMode === 'one' ? <Repeat1 size={ICON.md} /> : <Repeat size={ICON.md} />}
        </button>

        <button
          type="button"
          onClick={() => setAutoplayRadio(!autoplayRadio)}
          style={{
            background: 'none',
            border: 'none',
            color: autoplayRadio ? 'var(--accent)' : 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px'
          }}
          title={autoplayRadio ? 'Автопоток включён' : 'Автопоток выключен'}
          data-testid="mini-expanded-radio-btn"
        >
          <InfinityIcon size={ICON.md} />
        </button>
      </div>

      {/* Volume Bar & Dislike */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 4px' }}>
        <button
          type="button"
          onClick={() => void dislikeAndSkipCurrentTrack()}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center'
          }}
          title="Не рекомендовать (Дизлайк и пропуск)"
          data-testid="mini-expanded-dislike-btn"
        >
          <ThumbsDown size={ICON.sm} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
          <button
            type="button"
            onClick={toggleMute}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
              alignItems: 'center'
            }}
            title={isMuted ? 'Включить звук' : 'Выключить звук'}
          >
            {isMuted || volume === 0 ? <VolumeX size={ICON.sm} /> : <Volume2 size={ICON.sm} />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            style={
              {
                flex: 1,
                cursor: 'pointer',
                // Доля заливки — единственное, что компонент знает про облик
                // своего ползунка; всё остальное решает правило в global.css.
                // До него здесь стояли `accentColor` и `height: 4px`: первое —
                // мёртвая строка (у ползунка сброшен `appearance`, системная
                // раскраска до него не доходит), второе резало бегунок, который
                // ростом в `--range-thumb-size`.
                '--range-fill': `${Math.round((isMuted ? 0 : volume) * 100)}%`
              } as React.CSSProperties
            }
            title={`Громкость: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
            data-testid="mini-expanded-volume-slider"
          />
        </div>
      </div>

      {/* Up Next Preview Chip */}
      {upcomingTrack && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 8px',
            // Плашка «Далее» лежит на окне тем же спокойным washем, что и
            // прочие покоящиеся элементы, — тема сама решает его полярность.
            backgroundColor: 'var(--surface-hover)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)'
          }}
        >
          <ListMusic size={ICON.xs} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Далее:</span>
          <span className="text-truncate" style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 'var(--weight-medium)' }}>
            {upcomingTrack.title} — {upcomingTrack.artist}
          </span>
        </div>
      )}
    </div>
  );
};
