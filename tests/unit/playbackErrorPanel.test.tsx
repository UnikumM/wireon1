import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '../setup';
import { PlaybackErrorPanel } from '../../src/components/player/core/PlaybackErrorPanel';
import { PlayerIsland } from '../../src/components/player/PlayerIsland';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { describePlaybackAttempts } from '../../src/services/playbackErrors';
import type { UnifiedTrack } from '../../src/types/music';

/**
 * Панель ошибки по правилу «что случилось, что попробовали, что можно сделать»:
 * фраза для человека, строка о попытках приложения, «Повторить» и «Отправить
 * отчёт». Техническая причина остаётся во всплывающей подсказке.
 */

const sendUserReport = vi.fn(async () => true);
vi.mock('../../src/services/telemetry', () => ({
  sendUserReport: (...args: unknown[]) => sendUserReport(...(args as [])),
}));

const track: UnifiedTrack = {
  id: 'yt_abc123',
  source: 'youtube',
  originalId: 'abc123',
  title: 'Night Drive',
  artist: 'Wireon Wave',
  duration: 240,
  artworkUrl: 'https://example.com/art.jpg',
};

beforeEach(() => {
  sendUserReport.mockClear();
  useUIStore.setState({ toastMessage: null });
  usePlayerStore.setState({
    currentTrack: track,
    playbackState: 'error',
    error: 'YouTube не отдал аудио для этого видео.',
    errorDetail: 'YT_ALL_ATTEMPTS_FAILED: all clients refused abc123',
    errorCanRetry: true,
    substitutedFrom: null,
  });
});

describe('PlaybackErrorPanel', () => {
  it('показывает фразу, причину в подсказке и строку о попытках', () => {
    render(<PlaybackErrorPanel variant="bar" />);

    const message = screen.getByTestId('player-error-message');
    expect(message).toHaveTextContent('YouTube не отдал аудио для этого видео.');
    expect(message).toHaveAttribute('title', 'YT_ALL_ATTEMPTS_FAILED: all clients refused abc123');
    expect(screen.getByTestId('player-error-attempts')).toHaveTextContent(/SoundCloud/);
    expect(screen.getByTestId('player-error-retry')).toHaveTextContent('Повторить');
    expect(screen.getByTestId('player-error-report')).toHaveTextContent('Отправить отчёт');
  });

  it('«Повторить» зовёт play стора и не рисуется, когда повтор бессмыслен', () => {
    const play = vi.fn(async () => {});
    usePlayerStore.setState({ play });
    const { rerender } = render(<PlaybackErrorPanel variant="bar" />);

    fireEvent.click(screen.getByTestId('player-error-retry'));
    expect(play).toHaveBeenCalledTimes(1);

    act(() => {
      usePlayerStore.setState({ errorCanRetry: false });
    });
    rerender(<PlaybackErrorPanel variant="bar" />);
    expect(screen.queryByTestId('player-error-retry')).not.toBeInTheDocument();
  });

  it('«Отправить отчёт» шлёт ошибку с id трека и показывает тост', async () => {
    render(<PlaybackErrorPanel variant="bar" />);

    fireEvent.click(screen.getByTestId('player-error-report'));

    await waitFor(() => expect(useUIStore.getState().toastMessage?.text).toBe('Отчёт отправлен'));
    expect(sendUserReport).toHaveBeenCalledWith({
      message: 'YouTube не отдал аудио для этого видео.',
      detail: 'YT_ALL_ATTEMPTS_FAILED: all clients refused abc123',
      trackId: 'yt_abc123',
      source: 'youtube',
    });
    expect(screen.getByTestId('player-error-report')).toBeDisabled();
    expect(screen.getByTestId('player-error-report')).toHaveTextContent('Отчёт отправлен');
  });

  it('неудачная отправка оставляет кнопку и говорит об этом тостом', async () => {
    sendUserReport.mockResolvedValueOnce(false);
    render(<PlaybackErrorPanel variant="bar" />);

    fireEvent.click(screen.getByTestId('player-error-report'));

    await waitFor(() => expect(useUIStore.getState().toastMessage?.type).toBe('error'));
    expect(screen.getByTestId('player-error-report')).not.toBeDisabled();
  });

  it('«Скрыть» прячет панель до следующей ошибки', () => {
    const { rerender } = render(<PlaybackErrorPanel variant="bar" />);
    fireEvent.click(screen.getByTestId('player-error-dismiss'));
    expect(screen.queryByTestId('player-error')).not.toBeInTheDocument();

    // Та же ошибка — панель молчит; новая — появляется снова.
    act(() => {
      usePlayerStore.setState({ error: null, errorDetail: null });
    });
    act(() => {
      usePlayerStore.setState({ error: 'Нет соединения.', errorDetail: 'Failed to fetch' });
    });
    rerender(<PlaybackErrorPanel variant="bar" />);
    expect(screen.getByTestId('player-error-message')).toHaveTextContent('Нет соединения.');
  });

  it('компактный вариант на телефоне — текст, «Повторить» и «Скрыть»', () => {
    render(<PlayerIsland />);

    const panel = screen.getByTestId('player-error');
    expect(panel.className).toContain('playback-error-panel-compact');
    expect(screen.getByTestId('player-error-message')).toHaveTextContent('YouTube не отдал аудио');
    expect(screen.getByTestId('player-error-retry')).toBeInTheDocument();
    expect(screen.getByTestId('player-error-dismiss')).toBeInTheDocument();
    expect(screen.queryByTestId('player-error-report')).not.toBeInTheDocument();
    // Плашка сама остаётся на месте — панель её верхний этаж.
    expect(screen.getByTestId('mobile-player-bar')).toContainElement(panel);
  });

  it('без ошибки панели нет', () => {
    usePlayerStore.setState({ error: null, errorDetail: null, playbackState: 'paused' });
    render(<PlaybackErrorPanel variant="bar" />);
    expect(screen.queryByTestId('player-error')).not.toBeInTheDocument();
  });
});

describe('describePlaybackAttempts', () => {
  it('после отказа источника честно говорит про поиск у соседа', () => {
    expect(describePlaybackAttempts('YT_GEO_BLOCKED: blocked', 'youtube')).toMatch(/SoundCloud/);
    expect(describePlaybackAttempts("Error invoking remote method 'resolve-youtube-stream': Error: YT_BOT_CHECK: x", 'youtube')).toMatch(
      /SoundCloud/
    );
    expect(describePlaybackAttempts('SoundCloud track 1 is only offered as DRM-protected audio', 'soundcloud')).toMatch(
      /YouTube/
    );
  });

  it('играла копия с другого источника — об этом и сказано', () => {
    expect(describePlaybackAttempts('x', 'youtube', 'soundcloud')).toBe('YouTube эту запись не отдал, играла копия с SoundCloud.');
  });

  it('для сетевых и декодерных сбоев попыток не было — строки нет', () => {
    expect(describePlaybackAttempts('Failed to fetch', 'youtube')).toBeNull();
    expect(describePlaybackAttempts('YT_NETWORK: offline', 'youtube')).toBeNull();
    expect(describePlaybackAttempts(null, 'youtube')).toBeNull();
  });
});
