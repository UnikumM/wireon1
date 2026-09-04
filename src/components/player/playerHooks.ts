import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Measurement helpers that only the player surfaces need. Dismissal, focus
 * trapping, scroll locking, reduced-motion and artwork colour extraction all
 * come from `src/hooks/` so the player behaves exactly like every modal.
 */

/**
 * True only while the text genuinely does not fit, so a marquee is never
 * attached to a title that already fits.
 */
export function useTextOverflow(text: string): { ref: React.RefObject<HTMLSpanElement>; overflows: boolean } {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    /*
     * Мерить надо одну копию текста, а не всё содержимое.
     *
     * Включённая бегущая строка кладёт в элемент **две** копии — этим и держится
     * бесшовная петля. После этого `scrollWidth` всегда вдвое больше ширины, то
     * есть условие «не влезает» становится вечно истинным, и назад признак уже
     * не возвращается: раз поехав, название ползёт и в окне вдвое шире нужного.
     * Ровно это и было видно в полноэкранном плеере на 1280 px — короткое
     * название в коробке 640 px продолжало бежать.
     *
     * Первый дочерний элемент есть только у бегущей ветви; у обрезанной внутри
     * голый текст, и меряется сам элемент.
     */
    const measure = () => {
      const single = element.firstElementChild;
      const contentWidth = single ? single.scrollWidth : element.scrollWidth;
      setOverflows(contentWidth > element.clientWidth + 1);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return { ref, overflows };
}

/** Moves focus between the items of an open menu (roving focus, no index state). */
export function focusMenuItem(container: HTMLElement | null, direction: 'next' | 'prev' | 'first' | 'last'): void {
  if (!container) return;

  const items = Array.from(container.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  if (items.length === 0) return;

  if (direction === 'first') {
    items[0].focus();
    return;
  }
  if (direction === 'last') {
    items[items.length - 1].focus();
    return;
  }

  const active = document.activeElement as HTMLElement | null;
  const index = active ? items.indexOf(active) : -1;
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex = index === -1 ? 0 : (index + offset + items.length) % items.length;
  items[nextIndex].focus();
}

function remainingSeconds(endsAt: number | null): number {
  if (endsAt === null) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

/** Whole seconds left on an epoch-ms deadline; only ticks while one is armed. */
export function useCountdown(endsAt: number | null): number {
  const [remaining, setRemaining] = useState(() => remainingSeconds(endsAt));

  useEffect(() => {
    setRemaining(remainingSeconds(endsAt));
    if (endsAt === null) return;

    const handle = setInterval(() => setRemaining(remainingSeconds(endsAt)), 1000);
    return () => clearInterval(handle);
  }, [endsAt]);

  return remaining;
}
