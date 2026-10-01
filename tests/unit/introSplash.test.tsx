import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { IntroSplash, INTRO_FADE_MS, INTRO_MAX_MS } from '../../src/components/common/IntroSplash';

function mockReducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      }) as unknown as MediaQueryList
  );
}

describe('Вступительная заставка', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('уходит в конце ролика, плавно', () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const { container } = render(<IntroSplash />);

    fireEvent.ended(container.querySelector('video')!);
    expect(screen.getByTestId('intro-splash').className).toContain('is-leaving');

    act(() => vi.advanceTimersByTime(INTRO_FADE_MS));
    expect(screen.queryByTestId('intro-splash')).toBeNull();
  });

  it('ролик не пошёл — экран не держится: ошибка или сторож', () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const first = render(<IntroSplash />);
    fireEvent.error(first.container.querySelector('video')!);
    act(() => vi.advanceTimersByTime(INTRO_FADE_MS));
    expect(first.queryByTestId('intro-splash')).toBeNull();
    first.unmount();

    const second = render(<IntroSplash />);
    act(() => vi.advanceTimersByTime(INTRO_MAX_MS));
    act(() => vi.advanceTimersByTime(INTRO_FADE_MS));
    expect(second.queryByTestId('intro-splash')).toBeNull();
  });

  it('пропускается нажатием и клавишей', () => {
    vi.useFakeTimers();
    mockReducedMotion(false);
    const first = render(<IntroSplash />);
    fireEvent.click(first.getByTestId('intro-splash'));
    act(() => vi.advanceTimersByTime(INTRO_FADE_MS));
    expect(first.queryByTestId('intro-splash')).toBeNull();
    first.unmount();

    const second = render(<IntroSplash />);
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => vi.advanceTimersByTime(INTRO_FADE_MS));
    expect(second.queryByTestId('intro-splash')).toBeNull();
  });

  it('до первого кадра ролик скрыт, а постер прозрачный — без заглушки WebView', () => {
    mockReducedMotion(false);
    const { container } = render(<IntroSplash />);
    const video = container.querySelector('video')!;

    expect(video.getAttribute('poster')).toMatch(/^data:image\/gif;base64,/);
    expect(video.classList.contains('is-started')).toBe(false);

    fireEvent.playing(video);
    expect(video.classList.contains('is-started')).toBe(true);
  });

  it('при «меньше движения» не показывается вовсе', () => {
    mockReducedMotion(true);
    render(<IntroSplash />);
    expect(screen.queryByTestId('intro-splash')).toBeNull();
  });
});
