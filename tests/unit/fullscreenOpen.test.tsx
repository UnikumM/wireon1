import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, act, cleanup } from '@testing-library/react';
import '../setup';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Раскрытие полноэкранного плеера.
 *
 * Жалоба была про то, что окно «просто появляется»: слой во весь экран приходил
 * обычным `fadeIn`, и переход из полосы в плеер читался подменой картинки, а не
 * движением. Проверяется поэтому не «есть ли анимация вообще», а её устройство:
 * подложка собирается из размытия, а содержимое въезжает чередой, причём в том
 * порядке, в котором на него смотрят.
 *
 * Кадры проверяются чтением CSS с диска: `vitest.config.ts` идёт без `css: true`,
 * стили в прогоне не обрабатываются, и `getComputedStyle` про анимацию ничего не
 * скажет.
 */

const SRC = path.resolve(__dirname, '../../src');
const GLOBAL_CSS = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');

const track: UnifiedTrack = {
  id: 'yt_open_1',
  source: 'youtube',
  originalId: 'open_1',
  title: 'Slow Emerge',
  artist: 'Motion Tester',
  duration: 195,
  artworkUrl: 'https://example.com/open.jpg'
};

/** Блок правила по селектору — без вложенных фигурных скобок внутри. */
function ruleBody(selector: string): string {
  const start = GLOBAL_CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`нет правила ${selector}`);
  return GLOBAL_CSS.slice(start, GLOBAL_CSS.indexOf('}', start));
}

function openFullscreen(): void {
  act(() => {
    usePlayerStore.setState({ currentTrack: track, duration: track.duration });
    useUIStore.setState({ isFullscreenPlayerOpen: true });
  });
  render(<FullscreenPlayer />);
}

describe('Раскрытие полноэкранного плеера', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetLibraryStore();
    resetUIStore();
    vi.spyOn(dbService, 'getSetting').mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('слой приходит наводкой на резкость, а не простым проявлением', () => {
    openFullscreen();
    expect(screen.getByTestId('fullscreen-player').className).toContain('animate-emerge');
  });

  it('у кадров раскрытия есть размытие в начале и снятый фильтр в конце', () => {
    // Без размытия это обычный сдвиг вверх, то есть ровно то, что было.
    const frames = GLOBAL_CSS.slice(GLOBAL_CSS.indexOf('@keyframes emerge'));
    const body = frames.slice(0, frames.indexOf('\n}\n'));
    expect(body).toMatch(/filter:\s*blur\((?!0)/);
    // В конце именно `none`, а не `blur(0)`. Раньше здесь стоял ноль, и это была
    // ошибка, закреплённая тестом: класс объявлен с `both`, последний кадр
    // остаётся на элементе навсегда, а ненулевой фильтр — это постоянный слой
    // композитора во весь экран под визуализатором и система отсчёта для
    // `position: fixed` у всех потомков. Общее правило держит freshness.test.ts.
    expect(body).toMatch(/filter:\s*none/);
  });

  it('первый кадр удерживается до старта', () => {
    // Без `both` слой виден в конечном виде до начала анимации — вспышка на весь
    // экран, то есть та же жалоба, только на кадр раньше.
    expect(ruleBody('.animate-emerge')).toContain('both');
  });

  it('раскрытие идёт дольше обычного проявления', () => {
    // На 220 мс размытие успевает показать себя ровно один кадр и читается
    // рассинхроном отрисовки, а не движением.
    expect(ruleBody('.animate-emerge')).toContain('var(--dur-morph)');
  });

  it('содержимое въезжает чередой, а не всё разом', () => {
    openFullscreen();

    const staggered = Array.from(
      screen.getByTestId('fullscreen-player').querySelectorAll<HTMLElement>('.animate-rise')
    );
    // Шапка, обложка, название с транспортом.
    expect(staggered.length).toBeGreaterThanOrEqual(3);

    const steps = staggered.map((node) => Number(node.style.getPropertyValue('--stagger')));
    expect(steps.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('череда не заставляет ждать транспорт', () => {
    // Шаг череды — 40 мс на элемент (`.animate-rise` в global.css). Последний из
    // трёх шагов ждёт 80 мс: заметно как порядок, но не как задержка отклика.
    expect(ruleBody('.animate-rise')).toContain('40ms');
  });

  it('«сокращённое движение» снимает и раскрытие тоже', () => {
    // Длительности в этом режиме обнуляются целиком через `--dur-*` — и делает это
    // `theme.css`, где токены и объявлены. Поэтому от самого правила требуется
    // ровно одно: брать токен, а не своё число.
    const themeCss = readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8');
    const reduced = themeCss.slice(themeCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('--dur-morph: 1ms');
    expect(ruleBody('.animate-emerge')).not.toMatch(/\d+ms/);
  });
});
