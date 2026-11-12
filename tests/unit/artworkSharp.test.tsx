/**
 * Чёткая копия крупной обложки (4.0.2): лежит поверх мелкой, проявляется после
 * загрузки и откатывается по кандидатам, когда крупного кадра у видео нет.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';
import { NowPlayingArtwork } from '../../src/components/player/core/NowPlayingArtwork';
import type { UnifiedTrack } from '../../src/types/music';

const SMALL = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg';
const track: UnifiedTrack = { id: 'yt_1', source: 'youtube', originalId: 'dQw4w9WgXcQ', title: 'Трек', artist: 'Артист', duration: 100, artworkUrl: SMALL };

function loaded(image: HTMLElement, width: number, height: number) {
  Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true });
  fireEvent.load(image);
}

describe('NowPlayingArtwork: размер по месту', () => {
  it('без size — только картинка из медиатеки, лишних запросов нет', () => {
    const { container } = render(<NowPlayingArtwork track={track} morph={false} />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(SMALL);
  });

  it('крупная обложка: мелкая видна сразу, чёткая проявляется после загрузки', () => {
    const { container } = render(<NowPlayingArtwork track={track} morph={false} size={460} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(SMALL);

    const sharp = screen.getByTestId('artwork-sharp');
    expect(sharp.getAttribute('src')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
    expect(sharp.getAttribute('data-ready')).toBe('false');

    loaded(sharp, 1280, 720);
    expect(screen.getByTestId('artwork-sharp').getAttribute('data-ready')).toBe('true');
  });

  it('вместо крупного кадра пришла заглушка 120×90 — берётся следующий, потом остаётся мелкая', () => {
    render(<NowPlayingArtwork track={track} morph={false} size={460} />);

    loaded(screen.getByTestId('artwork-sharp'), 120, 90);
    const second = screen.getByTestId('artwork-sharp');
    expect(second.getAttribute('src')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg');
    expect(second.getAttribute('data-ready')).toBe('false');

    fireEvent.error(second);
    // Кандидаты кончились: чёткой копии нет, мелкая обложка на месте.
    expect(screen.queryByTestId('artwork-sharp')).toBeNull();
    expect(document.querySelector('img')?.getAttribute('src')).toBe(SMALL);
  });

  it('смена трека начинает подбор заново', () => {
    const { rerender } = render(<NowPlayingArtwork track={track} morph={false} size={460} />);
    loaded(screen.getByTestId('artwork-sharp'), 120, 90);

    const next = { ...track, id: 'yt_2', artworkUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg' };
    rerender(<NowPlayingArtwork track={next} morph={false} size={460} />);
    expect(screen.getByTestId('artwork-sharp').getAttribute('src')).toBe('https://i.ytimg.com/vi/aaaaaaaaaaa/maxresdefault.jpg');
  });
});
