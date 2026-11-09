import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup';
import { UnifiedTrack } from '../../src/types/music';
import { usePlayerStore, PLAYER_SETTING_KEYS } from '../../src/store/usePlayerStore';
import { PlaybackSettings } from '../../src/components/settings/PlaybackSettings';
import * as dbService from '../../src/services/db';
import { resetPlayerStore } from '../helpers/testUtils';

/**
 * Умный кроссфейд в хранилище и в настройках.
 *
 * Отдельный файл нарочно: ранний переход ставит в модуле хранилища флаг «переход
 * идёт» на несколько секунд, и соседний тест, где переход тоже ожидается, его бы
 * не дождался. Проверки движка — в crossfade.test.tsx.
 */

const albumA1: UnifiedTrack = {
  id: 'yt_album_1',
  source: 'youtube',
  originalId: 'album_1',
  title: 'Intro',
  artist: 'M83',
  album: 'Hurry Up, We\u2019re Dreaming',
  duration: 244,
  artworkUrl: 'https://example.com/art1.jpg'
};
const albumA2: UnifiedTrack = { ...albumA1, id: 'yt_album_2', title: 'Midnight City', duration: 300 };
const otherAlbum: UnifiedTrack = {
  id: 'sc_other',
  source: 'soundcloud',
  originalId: 'other',
  title: 'Strobe',
  artist: 'deadmau5',
  album: 'For Lack of a Better Name',
  duration: 637,
  artworkUrl: 'https://example.com/art2.jpg'
};

describe('Умный кроссфейд: хранилище и настройки', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resetPlayerStore();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    await dbService.clearAllData();
    vi.restoreAllMocks();
  });

  it('хранилище: в умном режиме внутри альбома ранний переход не запускается', () => {
    usePlayerStore.setState({
      currentTrack: albumA1,
      sourceQueue: [albumA1, albumA2],
      currentIndex: 0,
      isPlaying: true,
      isLoading: false,
      duration: 244,
      crossfadeEnabled: true,
      crossfadeDuration: 5,
      crossfadeSmart: true
    });
    const nextTrackSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();

    usePlayerStore.getState().syncProgress(241, 244, 244);
    expect(nextTrackSpy).not.toHaveBeenCalled();
  });

  it('хранилище: в умном режиме между альбомами переход начинается заранее', async () => {
    // Флаг «переход идёт» живёт в модуле ещё несколько секунд: сбрасываем его
    // подложными часами, чтобы соседний тест не ждал настоящих.
    vi.useFakeTimers();
    usePlayerStore.setState({
      currentTrack: albumA1,
      sourceQueue: [albumA1, otherAlbum],
      currentIndex: 0,
      isPlaying: true,
      isLoading: false,
      duration: 244,
      crossfadeEnabled: true,
      crossfadeDuration: 5,
      crossfadeSmart: true
    });
    const nextTrackSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();

    usePlayerStore.getState().syncProgress(241, 244, 244);
    try {
      expect(nextTrackSpy).toHaveBeenCalledWith(false);
      await vi.advanceTimersByTimeAsync(6100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('хранилище: без умного режима альбом не влияет на ранний переход', async () => {
    vi.useFakeTimers();
    usePlayerStore.setState({
      currentTrack: albumA1,
      sourceQueue: [albumA1, albumA2],
      currentIndex: 0,
      isPlaying: true,
      isLoading: false,
      duration: 244,
      crossfadeEnabled: true,
      crossfadeDuration: 5,
      crossfadeSmart: false
    });
    const nextTrackSpy = vi.spyOn(usePlayerStore.getState(), 'nextTrack').mockResolvedValue();

    usePlayerStore.getState().syncProgress(241, 244, 244);
    try {
      expect(nextTrackSpy).toHaveBeenCalledWith(false);
      await vi.advanceTimersByTimeAsync(6100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('хранилище: настройка сохраняется и поднимается из базы', async () => {
    usePlayerStore.getState().setCrossfadeSmart(true);
    expect(usePlayerStore.getState().crossfadeSmart).toBe(true);
    await waitFor(async () => {
      expect(await dbService.getSetting(PLAYER_SETTING_KEYS.crossfadeSmart, null)).toBe(true);
    });

    resetPlayerStore();
    usePlayerStore.setState({ crossfadeSmart: false, settingsHydrated: false });
    await usePlayerStore.getState().hydrateSettings();
    expect(usePlayerStore.getState().crossfadeSmart).toBe(true);
  });

  it('настройки: переключатель рядом с кроссфейдом, доступен только при включённом переходе', () => {
    render(<PlaybackSettings />);

    const smartToggle = screen.getByTestId('setting-crossfade-smart');
    expect(smartToggle).toBeDisabled();
    expect(screen.getByText('Внутри альбома треки идут встык, между разными — плавно.')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('setting-crossfade-enabled'));
    expect(smartToggle).toBeEnabled();
    expect(smartToggle).not.toBeChecked();

    fireEvent.click(smartToggle);
    expect(smartToggle).toBeChecked();
    expect(usePlayerStore.getState().crossfadeSmart).toBe(true);
  });
});
