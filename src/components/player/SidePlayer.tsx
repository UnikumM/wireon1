import { ICON } from '../../styles/icons';
import React from 'react';
import { Heart, ListMusic, Maximize2, Music2, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerLayoutStore } from '../../store/usePlayerLayoutStore';
import { formatDuration } from '../../utils/time';

export const SidePlayer: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const volume = usePlayerStore((s) => s.volume);
  const error = usePlayerStore((s) => s.error);
  const modules = usePlayerLayoutStore((s) => s.modules);
  const favorites = useLibraryStore((s) => s.favorites);
  const favorite = currentTrack && favorites.some((track) => track.id === currentTrack.id);
  const player = usePlayerStore.getState();
  return <section className="side-player" aria-label="Боковой плеер" data-testid="side-player">
    <button className="side-player-art" aria-label="Открыть плеер на весь экран" onClick={() => useUIStore.getState().setFullscreenPlayerOpen(true)}>
      {currentTrack?.artworkUrl ? <img src={currentTrack.artworkUrl} alt="" /> : <Music2 size={ICON.display} />}
    </button>
    <div className="side-player-title">{currentTrack?.title ?? 'Ничего не играет'}</div>
    <div className="side-player-artist">{currentTrack?.artist ?? 'Выберите трек'}</div>
    {error && <p role="alert">{error}</p>}
    <div className="side-player-transport">
      <button aria-label="Предыдущий трек" disabled={!currentTrack} onClick={() => void player.prevTrack()}><SkipBack size={ICON.lg} /></button>
      <button aria-label={isPlaying ? 'Пауза' : 'Играть'} disabled={!currentTrack || isLoading} onClick={() => void player.togglePlayPause()}>{isPlaying ? <Pause size={ICON.xl} /> : <Play size={ICON.xl} />}</button>
      <button aria-label="Следующий трек" disabled={!currentTrack} onClick={() => void player.nextTrack()}><SkipForward size={ICON.lg} /></button>
    </div>
    <label className="side-player-seek">{formatDuration(currentTime)} / {formatDuration(duration)}
      <input aria-label="Перемотка по треку" type="range" min={0} max={duration || 1} value={Math.min(currentTime, duration || 1)} disabled={!duration}
        onChange={(e) => player.seekTo(Number(e.target.value))} /></label>
    <div className="side-player-actions">
      {modules.favorite && <button aria-label={favorite ? 'Удалить из любимых' : 'В любимое'} aria-pressed={Boolean(favorite)} disabled={!currentTrack}
        onClick={() => { if (currentTrack) void useLibraryStore.getState().toggleFavorite(currentTrack); }}><Heart size={ICON.lg} fill={favorite ? 'currentColor' : 'none'} /></button>}
      {modules.shuffle && <button aria-label="Перемешать" aria-pressed={isShuffled} onClick={() => player.toggleShuffle()}><Shuffle size={ICON.lg} /></button>}
      {modules.repeat && <button aria-label={`Повтор: ${repeatMode}`} aria-pressed={repeatMode !== 'off'} onClick={() => player.cycleRepeatMode()}><Repeat size={ICON.lg} /><span>{repeatMode === 'one' ? '1' : ''}</span></button>}
      {modules.queue && <button aria-label="Очередь" onClick={() => useUIStore.getState().toggleQueue()}><ListMusic size={ICON.lg} /></button>}
      <button aria-label="Плеер на весь экран" onClick={() => useUIStore.getState().setFullscreenPlayerOpen(true)}><Maximize2 size={ICON.lg} /></button>
    </div>
    {modules.volume && <label className="side-player-volume">Громкость
      <input aria-label="Громкость" type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => player.setVolume(Number(e.target.value))} /></label>}
  </section>;
};
