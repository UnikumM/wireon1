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
      className="stack h-full justify-between" style={{ padding: '12px 14px', overflowY: 'auto', gap: '10px' }}
      data-testid="mini-player-expanded"
    >
      {/* Top Track Header */}
      <div className="row gap-3">
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
              className="fill-cover"
            />
          ) : (
            <div className="w-full h-full row justify-center text-faint">
              <Music2 size={ICON.xl} />
            </div>
          )}
        </div>

        <div className="grow">
          <div
            className="text-truncate text-sm weight-bold text-primary"
            style={{ lineHeight: 1.2 }}
            title={currentTrack?.title || 'Ничего не играет'}
          >
            {currentTrack?.title || 'Ничего не играет'}
          </div>
          <div
            className="text-truncate text-xs text-secondary mt-px"
            title={currentTrack?.artist || 'Выберите трек'}
          >
            {currentTrack?.artist || 'Выберите трек'}
          </div>
        </div>

        <button
          type="button"
          onClick={() => currentTrack && toggleFavorite(currentTrack)}
          className="pointer row bg-none border-none" style={{ color: isFav ? 'var(--accent)' : 'var(--text-muted)', padding: '6px' }}
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
        <div className="row-stretch justify-between text-xs text-muted mt-1">
          <span data-numeric>{formatDuration(currentTime)}</span>
          <span data-numeric>{formatDuration(duration)}</span>
        </div>
      </div>

      {/* Transport Controls */}
      <div className="row justify-between" style={{ padding: '0 4px' }}>
        <button
          type="button"
          onClick={toggleShuffle}
          className="pointer bg-none border-none p-1" style={{ color: isShuffled ? 'var(--accent)' : 'var(--text-muted)' }}
          title={isShuffled ? 'Перемешивание: вкл' : 'Перемешивание: выкл'}
          data-testid="mini-expanded-shuffle-btn"
        >
          <Shuffle size={ICON.md} />
        </button>

        <button
          type="button"
          onClick={() => prevTrack()}
          className="text-primary pointer bg-none border-none p-1"
          title="Предыдущий трек"
          data-testid="mini-expanded-prev-btn"
        >
          <SkipBack size={ICON.lg} />
        </button>

        <button
          type="button"
          onClick={() => togglePlayPause()}
          className="control-lg radius-full pointer row justify-center bg-accent border-none" style={{ color: 'var(--text-on-accent)', boxShadow: 'var(--shadow-md)' }}
          title={showPause ? 'Пауза' : 'Играть'}
          data-testid="mini-expanded-play-btn"
        >
          {isLoading ? (
            <Loader2 className="animate-spin" size={ICON.lg} />
          ) : showPause ? (
            <Pause size={ICON.lg} />
          ) : (
            <Play size={ICON.lg} className="ml-px" />
          )}
        </button>

        <button
          type="button"
          onClick={() => nextTrack(true)}
          className="text-primary pointer bg-none border-none p-1"
          title="Следующий трек"
          data-testid="mini-expanded-next-btn"
        >
          <SkipForward size={ICON.lg} />
        </button>

        <button
          type="button"
          onClick={cycleRepeatMode}
          className="pointer bg-none border-none p-1" style={{ color: repeatMode === 'off' ? 'var(--text-muted)' : 'var(--accent)' }}
          title={`Повтор: ${REPEAT_LABEL[repeatMode]}`}
          data-testid="mini-expanded-repeat-btn"
        >
          {repeatMode === 'one' ? <Repeat1 size={ICON.md} /> : <Repeat size={ICON.md} />}
        </button>

        <button
          type="button"
          onClick={() => setAutoplayRadio(!autoplayRadio)}
          className="pointer bg-none border-none p-1" style={{ color: autoplayRadio ? 'var(--accent)' : 'var(--text-muted)' }}
          title={autoplayRadio ? 'Автопоток включён' : 'Автопоток выключен'}
          data-testid="mini-expanded-radio-btn"
        >
          <InfinityIcon size={ICON.md} />
        </button>
      </div>

      {/* Volume Bar & Dislike */}
      <div className="row gap-2" style={{ padding: '0 4px' }}>
        <button
          type="button"
          onClick={() => void dislikeAndSkipCurrentTrack()}
          className="text-muted pointer row bg-none border-none p-1"
          title="Не рекомендовать (Дизлайк и пропуск)"
          data-testid="mini-expanded-dislike-btn"
        >
          <ThumbsDown size={ICON.sm} />
        </button>

        <div className="row flex-1" style={{ gap: '6px' }}>
          <button
            type="button"
            onClick={toggleMute}
            className="text-muted pointer row bg-none border-none" style={{ padding: '2px' }}
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
          <ListMusic size={ICON.xs} className="text-secondary shrink-0" />
          <span className="text-muted shrink-0">Далее:</span>
          <span className="text-truncate flex-1 text-primary weight-medium">
            {upcomingTrack.title} — {upcomingTrack.artist}
          </span>
        </div>
      )}
    </div>
  );
};
