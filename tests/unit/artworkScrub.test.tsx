import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { useArtworkScrub, SCRUB_HOLD_MS, SCRUB_INTENT_PX } from '../../src/components/player/core/useArtworkScrub';
import { PlayerStage } from '../../src/components/player/PlayerStage';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

/**
 * Точная перемотка по обложке.
 *
 * Проверяется то, чем жест ломает соседей, если быть невнимательным: тап по
 * обложке не должен перематывать, вертикаль до признания — не наш жест,
 * перемотка зовётся один раз на отпускание, а не на каждое движение, и ниже
 * палец — медленнее время.
 */

const DURATION = 240;
const SIZE = 300;

const Harness: React.FC<{ onSeek: (s: number) => void; currentTime?: number; enabled?: boolean }> = ({
  onSeek,
  currentTime = 60,
  enabled = true
}) => {
  const scrub = useArtworkScrub({ enabled, currentTime, duration: DURATION, onSeek });
  return (
    <div {...scrub.handlers} data-testid="zone">
      <output data-testid="active">{scrub.isScrubbing ? 'yes' : 'no'}</output>
      <output data-testid="position">{scrub.position.toFixed(2)}</output>
      <output data-testid="rate">{scrub.rate}</output>
      <output data-testid="delta">{scrub.delta.toFixed(2)}</output>
    </div>
  );
};

/** jsdom не меряет: размер зоны подставляется руками. */
function sizeZone(zone: HTMLElement) {
  vi.spyOn(zone, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: SIZE,
    bottom: SIZE,
    width: SIZE,
    height: SIZE,
    toJSON: () => ({})
  } as DOMRect);
}

const pointer = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, isPrimary: true });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useArtworkScrub', () => {
  it('короткий тап не считается перемоткой', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(150, 150));
    fireEvent.pointerUp(zone, pointer(152, 151));
    act(() => {
      vi.advanceTimersByTime(SCRUB_HOLD_MS * 2);
    });

    expect(screen.getByTestId('active').textContent).toBe('no');
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('горизонтальное ведение сразу ведёт позицию, перемотка одна — на отпускании', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} currentTime={60} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(100, 150));
    // Меньше порога — ещё ничего.
    fireEvent.pointerMove(zone, pointer(100 + SCRUB_INTENT_PX - 2, 150));
    expect(screen.getByTestId('active').textContent).toBe('no');

    // Порог пройден: жест признан без удержания, сдвиг 30 px из 300 — десятая трека.
    fireEvent.pointerMove(zone, pointer(130, 152));
    expect(screen.getByTestId('active').textContent).toBe('yes');
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(60 + DURATION * 0.1, 1);
    expect(Number(screen.getByTestId('delta').textContent)).toBeCloseTo(24, 1);

    fireEvent.pointerMove(zone, pointer(160, 152));
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(108, 1);
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerUp(zone, pointer(160, 152));
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0][0]).toBeCloseTo(108, 1);
    expect(screen.getByTestId('active').textContent).toBe('no');
    // Вне жеста позиция снова плеерная.
    expect(Number(screen.getByTestId('position').textContent)).toBe(60);
  });

  it('ниже палец — медленнее идёт время', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} currentTime={60} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(100, 20));
    fireEvent.pointerMove(zone, pointer(130, 20));
    expect(screen.getByTestId('rate').textContent).toBe('1');
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(84, 1);

    // Палец ушёл на 240 px вниз — точная зона: те же 30 px дают десятую от прежнего.
    fireEvent.pointerMove(zone, pointer(130, 260));
    expect(screen.getByTestId('rate').textContent).toBe('0.1');
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(84, 1);

    fireEvent.pointerMove(zone, pointer(160, 260));
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(84 + 2.4, 1);

    // Половинная зона по дороге обратно.
    fireEvent.pointerMove(zone, pointer(160, 110));
    expect(screen.getByTestId('rate').textContent).toBe('0.5');
    fireEvent.pointerMove(zone, pointer(190, 110));
    expect(Number(screen.getByTestId('position').textContent)).toBeCloseTo(86.4 + 12, 1);
  });

  it('удержание на месте начинает перемотку без движения', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(150, 150));
    act(() => {
      vi.advanceTimersByTime(SCRUB_HOLD_MS);
    });
    expect(screen.getByTestId('active').textContent).toBe('yes');
    expect(Number(screen.getByTestId('delta').textContent)).toBe(0);

    // Отпустили, не двигая: перематывать не к чему.
    fireEvent.pointerUp(zone, pointer(150, 150));
    expect(onSeek).not.toHaveBeenCalled();
    expect(screen.getByTestId('active').textContent).toBe('no');
  });

  it('вертикаль до признания — не наш жест: отсчёт сброшен, перемотки нет', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(150, 100));
    fireEvent.pointerMove(zone, pointer(152, 100 + SCRUB_INTENT_PX + 4));
    act(() => {
      vi.advanceTimersByTime(SCRUB_HOLD_MS * 2);
    });
    expect(screen.getByTestId('active').textContent).toBe('no');

    // Дальнейшее движение вбок к брошенному жесту не относится.
    fireEvent.pointerMove(zone, pointer(260, 130));
    fireEvent.pointerUp(zone, pointer(260, 130));
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('pointercancel отменяет без перемотки', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(100, 150));
    fireEvent.pointerMove(zone, pointer(160, 150));
    expect(screen.getByTestId('active').textContent).toBe('yes');

    fireEvent.pointerCancel(zone, pointer(160, 150));
    expect(screen.getByTestId('active').textContent).toBe('no');
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('клик после перемотки проглатывается, обычный — проходит', () => {
    const onSeek = vi.fn();
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <Harness onSeek={onSeek} />
      </div>
    );
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(100, 150));
    fireEvent.pointerMove(zone, pointer(160, 150));
    fireEvent.pointerUp(zone, pointer(160, 150));
    fireEvent.click(zone);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(zone);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('выключенный хук ничего не делает', () => {
    const onSeek = vi.fn();
    render(<Harness onSeek={onSeek} enabled={false} />);
    const zone = screen.getByTestId('zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(100, 150));
    fireEvent.pointerMove(zone, pointer(200, 150));
    fireEvent.pointerUp(zone, pointer(200, 150));
    expect(screen.getByTestId('active').textContent).toBe('no');
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe('Сцена телефона: оверлей перемотки', () => {
  const track: UnifiedTrack = {
    id: 'yt_scrub',
    source: 'youtube',
    originalId: 'scrub',
    title: 'Долгая песня',
    artist: 'Кто-то',
    duration: DURATION,
    artworkUrl: 'https://example.com/a.jpg',
    sourceUrl: 'https://youtube.com/watch?v=scrub'
  };

  beforeEach(() => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
    usePlayerStore.setState({ currentTrack: track, duration: DURATION, currentTime: 60 });
    useUIStore.setState({ isFullscreenPlayerOpen: true });
  });

  it('ведение по обложке показывает время крупно и ведёт ползунок; отпускание перематывает один раз', () => {
    const seekTo = vi.fn();
    usePlayerStore.setState({ seekTo });
    render(<PlayerStage />);
    const zone = screen.getByTestId('mobile-fullscreen-scrub-zone');
    sizeZone(zone);

    expect(screen.queryByTestId('mobile-fullscreen-scrub-overlay')).toBeNull();

    fireEvent.pointerDown(zone, pointer(100, 20));
    fireEvent.pointerMove(zone, pointer(190, 22));

    const overlay = screen.getByTestId('mobile-fullscreen-scrub-overlay');
    expect(overlay).toBeInTheDocument();
    // 90 px из 300 при обычной скорости — 72 с: 1:00 → 2:12.
    expect(screen.getByTestId('mobile-fullscreen-scrub-time').textContent).toBe('2:12');
    expect(screen.getByTestId('mobile-fullscreen-scrub-delta').textContent).toBe('+1:12');
    expect(overlay.textContent).toContain('Обычная');
    expect(screen.getByTestId('mobile-fullscreen-seek-slider')).toHaveAttribute('aria-valuenow', '132');

    // Ниже — точная зона, подпись меняется.
    fireEvent.pointerMove(zone, pointer(190, 280));
    expect(overlay.textContent).toContain('Очень точная');

    expect(seekTo).not.toHaveBeenCalled();
    fireEvent.pointerUp(zone, pointer(190, 280));
    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo.mock.calls[0][0]).toBeCloseTo(132, 1);
  });

  it('тап по обложке оверлея не вызывает', () => {
    const seekTo = vi.fn();
    usePlayerStore.setState({ seekTo });
    render(<PlayerStage />);
    const zone = screen.getByTestId('mobile-fullscreen-scrub-zone');
    sizeZone(zone);

    fireEvent.pointerDown(zone, pointer(150, 150));
    fireEvent.pointerUp(zone, pointer(150, 150));
    expect(screen.queryByTestId('mobile-fullscreen-scrub-overlay')).toBeNull();
    expect(seekTo).not.toHaveBeenCalled();
  });
});
