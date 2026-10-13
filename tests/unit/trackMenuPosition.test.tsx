import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../setup';
import { TrackCard } from '../../src/components/search/TrackCard';
import { UnifiedTrack } from '../../src/types/music';

const track: UnifiedTrack = { id: 'yt_m', source: 'youtube', originalId: 'm', title: 'Меню', artist: 'Тест', duration: 100, artworkUrl: '' };

function rect(top: number, bottom: number, right: number): DOMRect {
  return { top, bottom, right, left: right - 30, width: 30, height: bottom - top, x: right - 30, y: top, toJSON: () => ({}) } as DOMRect;
}

describe('3.0.1: меню трека стоит на экране, а не в строке', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('выносится в body и открывается вверх у нижнего края', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    const { container } = render(<TrackCard track={track} layout="row" />);
    const button = screen.getByTestId('track-more-btn-yt_m');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(740, 770, 1100));
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(220);
    fireEvent.click(button);
    const menu = screen.getByTestId('track-context-menu');
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    // 740 − 4 − 300 = 436: над кнопкой, а не под ней.
    expect(menu.style.top).toBe('436px');
    expect(menu.style.left).toBe('880px');
  });

  it('у верха — вниз от кнопки', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    render(<TrackCard track={track} layout="row" />);
    const button = screen.getByTestId('track-more-btn-yt_m');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(rect(100, 130, 1100));
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    fireEvent.click(button);
    expect(screen.getByTestId('track-context-menu').style.top).toBe('134px');
  });

  it('прокрутка закрывает меню', () => {
    render(<TrackCard track={track} layout="row" />);
    fireEvent.click(screen.getByTestId('track-more-btn-yt_m'));
    expect(screen.getByTestId('track-context-menu')).toBeTruthy();
    fireEvent.scroll(window);
    expect(screen.queryByTestId('track-context-menu')).toBeNull();
  });
});
