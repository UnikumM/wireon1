/**
 * Слой частиц.
 *
 * В jsdom нет ни настоящего 2D-контекста, ни раскладки, поэтому картинку здесь
 * проверить нечем — и не нужно: у поля частиц ломается не рисунок, а обвязка. Цикл,
 * который не остановился в фоне, кадр, который не отменился при размонтировании,
 * буфер в логических пикселях вместо физических — вот что стоит денег и заметно на
 * глаз. Поэтому контекст подменён заглушкой, а проверяются факты: сколько раз
 * запрошены кадры, чем стирается предыдущий, какого размера буфер и какие
 * слушатели остались после ухода компонента.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../setup';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ParticleField } from '../../src/components/fx/ParticleField';
import { DEFAULT_ACCENT_HEX } from '../../src/styles/palette';

/** Свойства контекста компонент только присваивает — запоминаем присвоенное. */
function record<T extends object, K extends keyof T>(target: T, key: K, sink: unknown[]): void {
  let value = target[key];
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => value,
    set: (next: T[K]) => {
      value = next;
      sink.push(next);
    }
  });
}

/** Заглушка 2D-контекста: считает вызовы и помнит присвоенные стили. */
function makeContext() {
  const composites: unknown[] = [];
  const strokes: unknown[] = [];
  const gradient = { addColorStop: vi.fn() };

  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    lineCap: 'butt',
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    drawImage: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    /** Всё, что присваивалось в `globalCompositeOperation`, по порядку. */
    composites,
    /** Все цвета, которыми рисовались штрихи. */
    strokes
  };

  record(ctx, 'globalCompositeOperation', composites);
  record(ctx, 'strokeStyle', strokes);
  return ctx;
}

/**
 * Подменяет `getContext` на прототипе.
 *
 * Контекстов два: спрайт свечения рисуется в свой холст, который в документ не
 * вставлен, — по этому и различаем. Иначе заливка спрайта попадала бы в счёт кадра
 * и «Дымка» выглядела бы профилем со следами.
 */
function installCanvas() {
  const main = makeContext();
  const sprite = makeContext();

  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
  getContext.mockImplementation(function (this: HTMLCanvasElement, id: string) {
    if (id !== '2d') return null;
    return this.isConnected ? main : sprite;
  } as unknown as HTMLCanvasElement['getContext']);

  return { main, sprite, getContext };
}

/** Кадры под ручным управлением: без этого цикл не остановить и не пересчитать. */
function trackFrames() {
  const queue: { id: number; callback: FrameRequestCallback }[] = [];
  let nextId = 1;

  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextId++;
    queue.push({ id, callback });
    return id;
  });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    const at = queue.findIndex((frame) => frame.id === id);
    if (at >= 0) queue.splice(at, 1);
  });

  return {
    requested: () => request.mock.calls.length,
    cancelled: () => cancel.mock.calls.map((call) => call[0]),
    /** Сколько кадров запрошено и ещё не проиграно. Больше одного — утечка цикла. */
    pending: () => queue.length,
    play: (time: number) => {
      const frame = queue.shift();
      expect(frame, 'кадр не был запрошен').toBeDefined();
      act(() => {
        frame?.callback(time);
      });
    }
  };
}

function setViewport(width: number, height: number, dpr = 1): void {
  const values: [string, number][] = [
    ['innerWidth', width],
    ['innerHeight', height],
    ['devicePixelRatio', dpr]
  ];
  for (const [key, value] of values) {
    Object.defineProperty(window, key, { configurable: true, writable: true, value });
  }
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function fireVisibility(): void {
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Системная просьба убрать движение. jsdom сам медиазапросы не считает. */
function mockReducedMotion(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }) as unknown as MediaQueryList
  );
}

/** Тот же цвет, что в `--accent` по умолчанию, но каналами. */
function defaultAccentRgb(): string {
  const packed = Number.parseInt(DEFAULT_ACCENT_HEX.slice(1), 16);
  return `rgb(${(packed >> 16) & 255}, ${(packed >> 8) & 255}, ${packed & 255})`;
}

describe('Поле частиц', () => {
  beforeEach(() => {
    setViewport(1024, 768, 1);
    setHidden(false);
  });

  afterEach(() => {
    // Уборка до восстановления моков: размонтирование обязано отменить кадр через
    // ту же заглушку, которая его выдала.
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--accent');
  });

  it('профиль «выключены» не создаёт холст и не просит ни одного кадра', () => {
    const { getContext } = installCanvas();
    const frames = trackFrames();

    const { container } = render(<ParticleField profile="off" />);

    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.queryByTestId('particle-field')).not.toBeInTheDocument();
    expect(getContext).not.toHaveBeenCalled();
    expect(frames.requested()).toBe(0);
  });

  it('декоративный слой не попадает в дерево доступности и оформлен классом, а не инлайном', () => {
    installCanvas();
    trackFrames();

    render(<ParticleField profile="sparks" className="под-шапкой" />);
    const canvas = screen.getByTestId('particle-field');

    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).toHaveClass('particle-field', 'под-шапкой');
    // Инлайновый стиль перебил бы fx.css: слой оказался бы вне слоёв и поверх окна.
    expect(canvas.getAttribute('style')).toBeNull();
  });

  it('держит буфер в физических пикселях и масштабирует контекст', () => {
    setViewport(800, 600, 2);
    const { main } = installCanvas();
    trackFrames();

    render(<ParticleField profile="sparks" />);
    const canvas = screen.getByTestId('particle-field') as HTMLCanvasElement;

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(main.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('перестраивает буфер под новый размер окна, не прерывая цикл', () => {
    setViewport(800, 600, 1);
    installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="sparks" />);
    const canvas = screen.getByTestId('particle-field') as HTMLCanvasElement;
    expect(canvas.width).toBe(800);

    setViewport(1200, 900, 1);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(900);
    frames.play(16);
    expect(frames.pending()).toBe(1);
  });

  it('«Искры» оставляют след частичным стиранием кадра, а не заливкой фоном', () => {
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="sparks" />);
    frames.play(16);

    expect(main.composites).toContain('destination-out');
    expect(main.fillRect).toHaveBeenCalled();
    // Полное стирание убрало бы след, а заливка цветом фона закрыла бы окно.
    expect(main.clearRect).not.toHaveBeenCalled();
  });

  it('«Дымка» стирает кадр целиком: следов у медленных пятен быть не должно', () => {
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="mist" />);
    frames.play(16);

    expect(main.clearRect).toHaveBeenCalled();
    expect(main.fillRect).not.toHaveBeenCalled();
    expect(main.composites).not.toContain('destination-out');
  });

  it('«Струи» рисуют штрихи, «Дымка» — только пятна', () => {
    const rain = installCanvas();
    const rainFrames = trackFrames();
    render(<ParticleField profile="rain" />);
    rainFrames.play(16);
    expect(rain.main.stroke).toHaveBeenCalled();

    cleanup();
    vi.restoreAllMocks();

    const mist = installCanvas();
    const mistFrames = trackFrames();
    render(<ParticleField profile="mist" />);
    mistFrames.play(16);
    expect(mist.main.stroke).not.toHaveBeenCalled();
    expect(mist.main.drawImage).toHaveBeenCalled();
  });

  it('«Буря» плотнее «Искр», но и она не рисует больше девяноста частиц за кадр', () => {
    // Заведомо больше, чем нужно на предел: 33 мегапикселя против 90 частиц.
    setViewport(7680, 4320, 1);
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="sparks" />);
    frames.play(16);
    const sparks = main.drawImage.mock.calls.length;

    // Уборка снимает кадр «Искр» с очереди, поэтому дальше играется кадр «Бури».
    cleanup();
    render(<ParticleField profile="storm" />);
    frames.play(16);
    const storm = main.drawImage.mock.calls.length - sparks;

    expect(sparks).toBeGreaterThan(0);
    expect(sparks).toBeLessThanOrEqual(34);
    expect(storm).toBeGreaterThan(sparks);
    expect(storm).toBeLessThanOrEqual(90);
  });

  it('берёт цвет из акцента документа, а не из своей константы', () => {
    document.documentElement.style.setProperty('--accent', '#ff0000');
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="rain" />);
    frames.play(16);

    expect(main.strokes).toContain('rgb(255, 0, 0)');
  });

  it('без объявленного акцента подставляет цвет по умолчанию, а не NaN', () => {
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="rain" />);
    frames.play(16);

    expect(main.strokes).toContain(defaultAccentRgb());
  });

  it('сокращённое движение рисует один статичный кадр и не заводит цикл', () => {
    mockReducedMotion();
    const { main } = installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="sparks" />);

    expect(frames.requested()).toBe(0);
    // Кадр всё же нарисован: просивший убрать движение получает фон, а не пустоту.
    expect(main.drawImage).toHaveBeenCalled();
  });

  it('скрытое окно останавливает цикл, возврат его возобновляет', () => {
    installCanvas();
    const frames = trackFrames();

    render(<ParticleField profile="storm" />);
    frames.play(16);
    expect(frames.pending()).toBe(1);

    setHidden(true);
    fireVisibility();
    expect(frames.cancelled().length).toBeGreaterThan(0);
    expect(frames.pending()).toBe(0);

    const requestedWhileHidden = frames.requested();
    setHidden(false);
    fireVisibility();
    expect(frames.requested()).toBe(requestedWhileHidden + 1);
    expect(frames.pending()).toBe(1);
  });

  it('размонтирование отменяет кадр и снимает все слушатели', () => {
    installCanvas();
    const frames = trackFrames();
    const windowOff = vi.spyOn(window, 'removeEventListener');
    const documentOff = vi.spyOn(document, 'removeEventListener');

    const { unmount } = render(<ParticleField profile="rain" />);
    frames.play(16);
    expect(frames.pending()).toBe(1);

    unmount();

    expect(frames.cancelled().length).toBeGreaterThan(0);
    expect(frames.pending()).toBe(0);
    expect(windowOff.mock.calls.map((call) => call[0])).toContain('resize');
    expect(documentOff.mock.calls.map((call) => call[0])).toContain('visibilitychange');
  });

  it('смена профиля не оставляет второй цикл', () => {
    installCanvas();
    const frames = trackFrames();

    const { rerender } = render(<ParticleField profile="sparks" />);
    frames.play(16);
    expect(frames.pending()).toBe(1);

    rerender(<ParticleField profile="storm" />);
    // Старый цикл снят, новый заведён — иначе кадров стало бы вдвое больше, и так
    // на каждое перемонтирование.
    expect(frames.pending()).toBe(1);

    frames.play(32);
    expect(frames.pending()).toBe(1);
  });
});
