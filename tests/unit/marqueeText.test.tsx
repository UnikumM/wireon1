import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '../setup';

import { MarqueeText } from '../../src/components/player/MarqueeText';

/**
 * Бегущая строка включается только тогда, когда название правда не влезает.
 *
 * Ловушка здесь одна и она неочевидна: включённая бегущая строка кладёт в
 * элемент **две** копии текста — этим и держится бесшовная петля. Если мерить
 * всё содержимое, то после включения ширина всегда вдвое больше коробки, и
 * признак «не влезает» становится вечно истинным. Строка, раз поехав, больше не
 * останавливается — ни на треке с коротким названием, ни в окне вдвое шире.
 */

/**
 * Подменяет измерения: jsdom не считает раскладку, `scrollWidth` и
 * `clientWidth` у него всегда нули. Коробка — сто пикселей, буква — десять.
 */
function stubMeasurements(boxWidth = 100, perChar = 10) {
  const restore: Array<() => void> = [];
  const original = {
    scrollWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
  };

  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return boxWidth;
    }
  });
  Object.defineProperty(Element.prototype, 'scrollWidth', {
    configurable: true,
    get(this: Element) {
      return (this.textContent?.length ?? 0) * perChar;
    }
  });

  restore.push(() => {
    if (original.scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', original.scrollWidth);
    else delete (Element.prototype as unknown as Record<string, unknown>).scrollWidth;
    if (original.clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', original.clientWidth);
    else delete (Element.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  return () => restore.forEach((undo) => undo());
}

const LONG = 'Ghosts of the Late Night Radio Tower';
/*
 * Семь букв — семьдесят пикселей: одна копия в сотню влезает, две уже нет.
 * Именно на таком названии и ловится замер по всему содержимому: короткое
 * название после длинного продолжало бежать.
 */
const SHORT = 'Кукушка';

describe('MarqueeText', () => {
  let undoStub: () => void;

  beforeEach(() => {
    undoStub = stubMeasurements();
  });

  afterEach(() => {
    cleanup();
    undoStub();
    vi.restoreAllMocks();
  });

  it('обрезает то, что влезает, и не двигает ничего попусту', () => {
    render(<MarqueeText text={SHORT} data-testid="title" />);

    const title = screen.getByTestId('title');
    expect(title).toHaveClass('text-truncate');
    expect(title).not.toHaveClass('marquee');
    // Вторая копия — только у бегущей ветви.
    expect(title.children).toHaveLength(0);
  });

  it('пускает строку, когда название действительно длиннее коробки', () => {
    render(<MarqueeText text={LONG} data-testid="title" />);

    const title = screen.getByTestId('title');
    expect(title).toHaveClass('marquee');
    expect(title.children).toHaveLength(2);
  });

  it('останавливается на следующем треке, если его название влезает', () => {
    const { rerender } = render(<MarqueeText text={LONG} data-testid="title" />);
    expect(screen.getByTestId('title')).toHaveClass('marquee');

    rerender(<MarqueeText text={SHORT} data-testid="title" />);

    // Здесь и ломалось: к моменту замера в элементе уже лежат две копии нового
    // короткого названия, и по общей ширине оно «не влезает» — хотя влезает.
    const title = screen.getByTestId('title');
    expect(title).toHaveClass('text-truncate');
    expect(title).not.toHaveClass('marquee');
    expect(title.children).toHaveLength(0);
  });

  it('молчит при просьбе уменьшить движение — даже если не влезает', () => {
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

    render(<MarqueeText text={LONG} data-testid="title" />);

    const title = screen.getByTestId('title');
    expect(title).toHaveClass('text-truncate');
    // Название при этом не теряется: оно обрезано и целиком лежит в `title`.
    expect(title).toHaveAttribute('title', LONG);
  });
});
