import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Оконная отрисовка длинных списков.
 *
 * Плейлист на полторы тысячи треков раскладывать целиком дорого: браузер держит
 * полторы тысячи узлов, и на слабой машине прокрутка начинает дёргаться.
 * Поэтому в DOM живёт только то, что видно, плюс запас сверху и снизу, а место
 * остальных строк занимают отступы контейнера — полоса прокрутки остаётся
 * правильной длины.
 *
 * Два умышленных ограничения:
 *  - строки считаются одинаковой высоты (в списках треков так и есть);
 *  - если высоту измерить нельзя (jsdom, элемент ещё не в раскладке) или строк
 *    мало, отрисовывается всё. Лучше лишние узлы, чем спрятанный контент.
 */

export interface VirtualWindowInput {
  scrollTop: number;
  viewportHeight: number;
  /** Отступ начала списка от начала области прокрутки, px. */
  containerOffset: number;
  /** Шаг строки: высота + промежуток. */
  rowPitch: number;
  itemCount: number;
  overscan: number;
}

export interface VirtualWindow {
  startIndex: number;
  /** Не включительно. */
  endIndex: number;
  paddingTop: number;
  paddingBottom: number;
}

export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { itemCount, rowPitch, overscan } = input;
  const everything: VirtualWindow = {
    startIndex: 0,
    endIndex: Math.max(0, itemCount),
    paddingTop: 0,
    paddingBottom: 0
  };

  if (itemCount <= 0 || rowPitch <= 0 || !Number.isFinite(rowPitch)) return everything;
  // Высоты нет — значит и судить о том, что видно, нечем.
  if (!Number.isFinite(input.viewportHeight) || input.viewportHeight <= 0) return everything;

  const scrolledIntoList = Math.max(0, input.scrollTop - Math.max(0, input.containerOffset));
  const firstVisible = Math.floor(scrolledIntoList / rowPitch);
  const visibleCount = Math.ceil(input.viewportHeight / rowPitch);

  const startIndex = Math.max(0, Math.min(itemCount - 1, firstVisible - overscan));
  const endIndex = Math.max(startIndex + 1, Math.min(itemCount, firstVisible + visibleCount + overscan));

  return {
    startIndex,
    endIndex,
    paddingTop: startIndex * rowPitch,
    paddingBottom: Math.max(0, (itemCount - endIndex) * rowPitch)
  };
}

/** Ближайший прокручиваемый родитель — к нему и слушаемся. */
function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

export interface UseVirtualRowsOptions<T extends HTMLElement = HTMLDivElement> {
  itemCount: number;
  /** Высота строки вместе с промежутком до следующей, px. */
  rowPitch: number;
  /** Сколько строк держать за краями экрана. */
  overscan?: number;
  /** Короче этого списка виртуализация не включается. */
  threshold?: number;
  /**
   * Готовый ref контейнера, если он уже нужен вызывающему коду (например, для
   * возврата фокуса после перестановки строк).
   */
  containerRef?: React.RefObject<T>;
}

export interface UseVirtualRowsResult<T extends HTMLElement = HTMLDivElement> extends VirtualWindow {
  containerRef: React.RefObject<T>;
  /** `false`, когда список отрисован целиком. */
  isVirtual: boolean;
}

export const VIRTUAL_LIST_THRESHOLD = 60;
const DEFAULT_OVERSCAN = 8;

/**
 * Шаг строки трека: обложка 40px + отбивки 2×8px + рамка 2px + промежуток 4px.
 *
 * Величина приблизительная и влияет только на длину полосы прокрутки и на запас
 * строк — сами строки раскладывает браузер, поэтому ошибка в пару пикселей
 * ничего не ломает.
 */
export const TRACK_ROW_PITCH = 62;

export function useVirtualRows<T extends HTMLElement = HTMLDivElement>(
  options: UseVirtualRowsOptions<T>
): UseVirtualRowsResult<T> {
  const { itemCount, rowPitch } = options;
  const overscan = options.overscan ?? DEFAULT_OVERSCAN;
  const threshold = options.threshold ?? VIRTUAL_LIST_THRESHOLD;

  const ownRef = useRef<T>(null);
  const containerRef = options.containerRef ?? ownRef;
  const enabled = itemCount > threshold;

  const [window_, setWindow] = useState<VirtualWindow>({
    startIndex: 0,
    endIndex: itemCount,
    paddingTop: 0,
    paddingBottom: 0
  });

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const scrollParent = findScrollParent(container);
    const viewportHeight = scrollParent
      ? scrollParent.clientHeight
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 0;
    const scrollTop = scrollParent ? scrollParent.scrollTop : 0;
    const containerOffset = scrollParent
      ? container.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top + scrollTop
      : 0;

    setWindow(
      computeVirtualWindow({
        scrollTop,
        viewportHeight,
        containerOffset,
        rowPitch,
        itemCount,
        overscan
      })
    );
  }, [itemCount, overscan, rowPitch]);

  useLayoutEffect(() => {
    if (!enabled) {
      setWindow({ startIndex: 0, endIndex: itemCount, paddingTop: 0, paddingBottom: 0 });
      return;
    }

    measure();

    const container = containerRef.current;
    const scrollParent = findScrollParent(container);
    const target: HTMLElement | Window = scrollParent ?? window;

    // `passive` — обработчик ничего не отменяет, и браузер не ждёт его перед
    // прокруткой.
    target.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);

    return () => {
      target.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [enabled, itemCount, measure]);

  // Список стал длиннее или короче — пересчитываем, не дожидаясь прокрутки.
  useEffect(() => {
    if (enabled) measure();
  }, [enabled, itemCount, measure]);

  if (!enabled) {
    return {
      containerRef,
      isVirtual: false,
      startIndex: 0,
      endIndex: itemCount,
      paddingTop: 0,
      paddingBottom: 0
    };
  }

  const endIndex = Math.min(window_.endIndex, itemCount);
  const startIndex = Math.min(window_.startIndex, Math.max(0, endIndex - 1));

  return {
    containerRef,
    isVirtual: endIndex - startIndex < itemCount,
    startIndex,
    endIndex,
    paddingTop: startIndex * rowPitch,
    paddingBottom: Math.max(0, (itemCount - endIndex) * rowPitch)
  };
}
