import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import '../setup';

import {
  computeVirtualWindow,
  useVirtualRows,
  VIRTUAL_LIST_THRESHOLD,
  TRACK_ROW_PITCH
} from '../../src/hooks/useVirtualRows';

/**
 * Оконная отрисовка длинных списков.
 *
 * Считающая часть проверяется напрямую — это чистая арифметика. Отдельно
 * проверяется главная страховка: когда высоту измерить нельзя (jsdom, элемент
 * ещё не в раскладке), список должен отрисоваться целиком, иначе половина
 * интерфейса просто исчезнет.
 */

const base = {
  scrollTop: 0,
  viewportHeight: 600,
  containerOffset: 0,
  rowPitch: 50,
  itemCount: 1000,
  overscan: 5
};

describe('computeVirtualWindow', () => {
  it('в начале списка отдаёт первый экран с запасом', () => {
    const w = computeVirtualWindow(base);

    expect(w.startIndex).toBe(0);
    // 600 / 50 = 12 видимых + 5 запаса.
    expect(w.endIndex).toBe(17);
    expect(w.paddingTop).toBe(0);
    expect(w.paddingBottom).toBe((1000 - 17) * 50);
  });

  it('сдвигает окно при прокрутке и держит запас сверху', () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 5000 });

    // 5000 / 50 = строка 100, минус 5 запаса.
    expect(w.startIndex).toBe(95);
    expect(w.endIndex).toBe(117);
    expect(w.paddingTop).toBe(95 * 50);
  });

  it('отступы всегда покрывают неотрисованное — полоса прокрутки не прыгает', () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 12345 });
    const rendered = (w.endIndex - w.startIndex) * base.rowPitch;

    expect(w.paddingTop + rendered + w.paddingBottom).toBe(base.itemCount * base.rowPitch);
  });

  it('учитывает отступ списка от начала области прокрутки', () => {
    // Список начинается на 400px ниже — значит первые 400px прокрутки его не касаются.
    const w = computeVirtualWindow({ ...base, scrollTop: 400, containerOffset: 400 });

    expect(w.startIndex).toBe(0);
  });

  it('в конце списка не выходит за его границы', () => {
    const w = computeVirtualWindow({ ...base, scrollTop: 999 * 50 });

    expect(w.endIndex).toBe(1000);
    expect(w.startIndex).toBeLessThan(1000);
    expect(w.paddingBottom).toBe(0);
  });

  it('без измеримой высоты отрисовывает всё', () => {
    for (const viewportHeight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const w = computeVirtualWindow({ ...base, viewportHeight });
      expect(w).toEqual({ startIndex: 0, endIndex: 1000, paddingTop: 0, paddingBottom: 0 });
    }
  });

  it('без осмысленного шага строки отрисовывает всё', () => {
    for (const rowPitch of [0, -10, Number.NaN]) {
      const w = computeVirtualWindow({ ...base, rowPitch });
      expect(w.endIndex).toBe(1000);
      expect(w.paddingTop).toBe(0);
    }
  });

  it('на пустом списке ничего не отрисовывает и не уходит в минус', () => {
    const w = computeVirtualWindow({ ...base, itemCount: 0 });

    expect(w).toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 });
  });

  it('всегда отдаёт хотя бы одну строку', () => {
    // Экран ниже списка целиком — окно всё равно непустое.
    const w = computeVirtualWindow({ ...base, itemCount: 3, scrollTop: 100_000 });

    expect(w.endIndex).toBeGreaterThan(w.startIndex);
  });
});

/** Список с искусственно заданной высотой прокручиваемого родителя. */
const List: React.FC<{ count: number; pitch?: number }> = ({ count, pitch = TRACK_ROW_PITCH }) => {
  const virtual = useVirtualRows({ itemCount: count, rowPitch: pitch });

  return (
    <div data-testid="scroller" style={{ overflowY: 'auto', height: '600px' }}>
      <div
        ref={virtual.containerRef}
        data-testid="list"
        data-virtual={virtual.isVirtual ? 'yes' : 'no'}
        style={{ paddingTop: virtual.paddingTop, paddingBottom: virtual.paddingBottom }}
      >
        {Array.from({ length: count }, (_, i) => i)
          .slice(virtual.startIndex, virtual.endIndex)
          .map((i) => (
            <div key={i} data-testid={`row-${i}`}>
              Строка {i}
            </div>
          ))}
      </div>
    </div>
  );
};

/** jsdom не считает раскладку, поэтому высоту прокручиваемого родителя задаём сами. */
function stubViewport(height: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.getAttribute?.('data-testid') === 'scroller' ? height : 0;
    }
  });
}

function restoreViewport() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 0;
    }
  });
}

describe('useVirtualRows', () => {
  afterEach(() => {
    restoreViewport();
  });

  it('короткий список отрисовывает целиком и без отступов', () => {
    stubViewport(600);
    render(<List count={20} />);

    expect(screen.getByTestId('list')).toHaveAttribute('data-virtual', 'no');
    expect(screen.getByTestId('row-0')).toBeInTheDocument();
    expect(screen.getByTestId('row-19')).toBeInTheDocument();
    expect(screen.getByTestId('list').style.paddingTop).toBe('0px');
  });

  it('длинный список держит в DOM только окно, а место остальных занимают отступы', () => {
    stubViewport(600);
    render(<List count={500} />);

    const list = screen.getByTestId('list');
    expect(list).toHaveAttribute('data-virtual', 'yes');
    expect(screen.getByTestId('row-0')).toBeInTheDocument();
    expect(screen.queryByTestId('row-400')).not.toBeInTheDocument();
    // Отступ снизу подпирает полосу прокрутки на всю длину списка.
    expect(parseInt(list.style.paddingBottom, 10)).toBeGreaterThan(400 * TRACK_ROW_PITCH);
  });

  it('прокрутка меняет окно: далёкие строки появляются, ближние уходят', () => {
    stubViewport(600);
    render(<List count={500} />);

    const scroller = screen.getByTestId('scroller');
    const list = screen.getByTestId('list');

    // В jsdom нет раскладки: прокрутку и координаты приходится изображать
    // руками. В браузере верх списка уезжает вверх ровно на scrollTop —
    // именно так хук и вычисляет, сколько строк ушло за край.
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      }
    });
    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    list.getBoundingClientRect = () => ({ top: -top }) as DOMRect;

    act(() => {
      scroller.scrollTop = 200 * TRACK_ROW_PITCH;
      scroller.dispatchEvent(new Event('scroll'));
    });

    expect(screen.getByTestId('row-200')).toBeInTheDocument();
    expect(screen.queryByTestId('row-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('list').style.paddingTop).not.toBe('0px');
  });

  it('если высоту измерить нельзя, отрисовывает всё — лучше лишние узлы, чем пустой экран', () => {
    // clientHeight = 0 у всех: ровно то, что происходит в jsdom и до раскладки.
    restoreViewport();
    render(<List count={300} />);

    expect(screen.getByTestId('row-0')).toBeInTheDocument();
    expect(screen.getByTestId('row-299')).toBeInTheDocument();
  });

  it('порог виртуализации — граница, а не примерное значение', () => {
    stubViewport(600);
    const { unmount } = render(<List count={VIRTUAL_LIST_THRESHOLD} />);
    expect(screen.getByTestId('list')).toHaveAttribute('data-virtual', 'no');
    unmount();

    render(<List count={VIRTUAL_LIST_THRESHOLD + 1} />);
    expect(screen.getByTestId('list')).toHaveAttribute('data-virtual', 'yes');
  });
});
