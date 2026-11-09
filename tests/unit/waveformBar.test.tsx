import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WaveformBar } from '../../src/components/player/WaveformBar';
import { SeekBar } from '../../src/components/player/SeekBar';

const samples = Array.from({ length: 120 }, (_, i) => ((i % 10) + 1) / 10);

/** В jsdom у элементов нет размеров: дорожка считается от 0 до 200 px. */
function layOut(element: Element, width = 200) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: width,
    top: 0,
    bottom: 32,
    width,
    height: 32,
    x: 0,
    y: 0,
    toJSON: () => ({})
  } as DOMRect);
}

afterEach(cleanup);

describe('WaveformBar — волна как ползунок', () => {
  it('объявляет контракт ползунка: роль, границы, позиция и подпись', () => {
    render(<WaveformBar samples={samples} progress={0.5} duration={200} onSeek={() => {}} idPrefix="fullscreen" />);

    const slider = screen.getByTestId('fullscreen-seek-slider');
    expect(slider.tagName.toLowerCase()).toBe('svg');
    expect(slider).toHaveAttribute('role', 'slider');
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '200');
    expect(slider).toHaveAttribute('aria-valuenow', '100');
    expect(slider).toHaveAttribute('aria-valuetext', '1:40 из 3:20');
    expect(slider).toHaveAttribute('tabindex', '0');
    // Все столбики на месте — по одному прямоугольнику на отсчёт.
    expect(slider.querySelectorAll('defs g rect')).toHaveLength(120);
  });

  it('клик по дорожке перематывает к доле под курсором', () => {
    const onSeek = vi.fn();
    render(<WaveformBar samples={samples} progress={0} duration={200} onSeek={onSeek} />);
    const slider = screen.getByTestId('player-seek-slider');
    layOut(slider);

    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled(); // до отпускания — только предпросмотр
    expect(slider).toHaveAttribute('data-scrubbing', 'true');
    fireEvent.pointerUp(slider, { clientX: 50, pointerId: 1 });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0.25);
    expect(slider).not.toHaveAttribute('data-scrubbing');
  });

  it('протаскивание ведёт позицию за пальцем и перематывает один раз при отпускании', () => {
    const onSeek = vi.fn();
    const onScrub = vi.fn();
    render(<WaveformBar samples={samples} progress={0} duration={200} onSeek={onSeek} onScrub={onScrub} />);
    const slider = screen.getByTestId('player-seek-slider');
    layOut(slider);

    fireEvent.pointerDown(slider, { clientX: 20, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(slider, { clientX: 180, pointerId: 1 });
    expect(onScrub.mock.calls.map(([f]) => f)).toEqual([0.1, 0.5, 0.9]);
    expect(slider).toHaveAttribute('aria-valuenow', '180');

    // Палец отпущен за пределами дорожки — слушает окно.
    fireEvent.pointerUp(window, { clientX: 400, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(0.9);
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('стрелки двигают на пять секунд, Home и End — в края', () => {
    const onSeek = vi.fn();
    render(<WaveformBar samples={samples} progress={0.5} duration={200} onSeek={onSeek} />);
    const slider = screen.getByTestId('player-seek-slider');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(105 / 200);
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(95 / 200);
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: 'Tab' });
    expect(onSeek).toHaveBeenCalledTimes(4);
  });

  it('наведение подсвечивает столбик под курсором и гасит его при уходе', () => {
    render(<WaveformBar samples={samples} progress={0} duration={200} onSeek={() => {}} />);
    const slider = screen.getByTestId('player-seek-slider');
    layOut(slider);

    expect(screen.queryByTestId('player-waveform-hover')).toBeNull();
    fireEvent.pointerMove(slider, { clientX: 101, pointerId: 1 });
    const hover = screen.getByTestId('player-waveform-hover');
    expect(hover).toHaveClass('waveform-bar-hover');
    // 101/200 → столбик 60 из 120.
    expect(hover).toHaveAttribute('x', String(60 + 0.175));
    fireEvent.pointerLeave(slider);
    expect(screen.queryByTestId('player-waveform-hover')).toBeNull();
  });

  it('без длительности не перематывает и выпадает из обхода Tab', () => {
    const onSeek = vi.fn();
    render(<WaveformBar samples={samples} progress={0} duration={0} onSeek={onSeek} />);
    const slider = screen.getByTestId('player-seek-slider');
    layOut(slider);

    expect(slider).toHaveAttribute('aria-disabled', 'true');
    expect(slider).toHaveAttribute('tabindex', '-1');
    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });
    fireEvent.pointerUp(slider, { clientX: 50, pointerId: 1 });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).not.toHaveBeenCalled();
  });
});

describe('SeekBar с волной', () => {
  it('в просторном варианте рисует волну под тем же testid и отдаёт секунды', () => {
    const onSeek = vi.fn();
    render(
      <SeekBar
        currentTime={60}
        duration={200}
        buffered={100}
        onSeek={onSeek}
        variant="comfortable"
        idPrefix="fullscreen"
        waveform={samples}
      />
    );

    const slider = screen.getByTestId('fullscreen-seek-slider');
    expect(slider.tagName.toLowerCase()).toBe('svg');
    expect(slider).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByTestId('fullscreen-current-time')).toHaveTextContent('1:00');
    expect(screen.getByTestId('fullscreen-duration')).toHaveTextContent('3:20');

    layOut(slider);
    fireEvent.pointerDown(slider, { clientX: 50, pointerId: 1 });
    // Пока палец на дорожке, время слева показывает место под ним.
    expect(screen.getByTestId('fullscreen-current-time')).toHaveTextContent('0:50');
    fireEvent.pointerUp(slider, { clientX: 50, pointerId: 1 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(50);
  });

  it('без волны и в компактном варианте остаётся обычный ползунок', () => {
    const { rerender } = render(
      <SeekBar currentTime={60} duration={200} buffered={100} onSeek={() => {}} variant="comfortable" waveform={null} />
    );
    expect(screen.getByTestId('player-seek-slider').tagName.toLowerCase()).toBe('input');

    rerender(
      <SeekBar currentTime={60} duration={200} buffered={100} onSeek={() => {}} variant="compact" waveform={samples} />
    );
    expect(screen.getByTestId('player-seek-slider').tagName.toLowerCase()).toBe('input');
  });

  it('длительность ещё неизвестна — волна не рисуется даже при наличии формы', () => {
    render(<SeekBar currentTime={0} duration={0} buffered={0} onSeek={() => {}} variant="comfortable" waveform={samples} />);
    expect(screen.getByTestId('player-seek-slider').tagName.toLowerCase()).toBe('input');
  });
});
