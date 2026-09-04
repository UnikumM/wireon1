import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './useMediaQuery';

/**
 * Закрытие потягиванием вниз — тем жестом, которым закрывают лист на телефоне.
 *
 * До этого выйти из полноэкранного плеера можно было только значком 46×46 в
 * левом верхнем углу — единственном месте экрана, куда большой палец не
 * достаёт. Жест не заменяет кнопку, а становится вторым выходом: кнопка нужна
 * мыши и клавиатуре, жест — руке.
 *
 * Слой едет за пальцем один к одному, без сопротивления и без «резинки»: лист
 * не тянут, а сдвигают, и любое расхождение с пальцем читается как задержка.
 */

/** Сколько нужно протащить, чтобы отпускание закрыло, а не вернуло на место. */
export const SWIPE_DISMISS_THRESHOLD_PX = 120;

/**
 * Скорость, при которой закрывает и короткий бросок. Пиксели за миллисекунду:
 * 0.5 — это спокойный смах, который человек делает, не задумываясь о том, на
 * сколько именно он сдвинул.
 */
export const SWIPE_DISMISS_VELOCITY = 0.5;

/** Сколько едет уход за край. Совпадает с `--dur-slow` в теме. */
export const SWIPE_DISMISS_EXIT_MS = 220;

/**
 * Насколько горизонтальным должно быть движение, чтобы жест не считался
 * закрытием. Палец никогда не идёт строго вниз, поэтому сравнение идёт с
 * запасом, а не «dy больше dx».
 */
const VERTICAL_INTENT_RATIO = 1.2;

/** Сдвиг, после которого намерение уже понятно и слой начинает ехать. */
const INTENT_SLOP_PX = 8;

/**
 * Откуда жест не начинается: органы управления и то, что прокручивается само.
 *
 * Без этого протаскивание по таймлайну закрывало бы плеер вместо перемотки —
 * ползунок и жест ловят одно и то же движение.
 */
const IGNORED_ORIGIN =
  'button, a, input, select, textarea, [role="slider"], [data-swipe-ignore]';

export interface SwipeDismissOptions {
  /** Выключенный жест не вешает обработчиков вовсе. */
  enabled: boolean;
  onDismiss: () => void;
  thresholdPx?: number;
}

export interface SwipeDismissResult {
  /** Текущий сдвиг вниз в пикселях; 0 — на месте. */
  offset: number;
  /** Палец на экране и слой едет за ним. */
  isDragging: boolean;
  /** Слой уходит за нижний край; закрытие уже решено. */
  isClosing: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
  };
}

export function useSwipeDismiss({
  enabled,
  onDismiss,
  thresholdPx = SWIPE_DISMISS_THRESHOLD_PX
}: SwipeDismissOptions): SwipeDismissResult {
  const prefersReducedMotion = usePrefersReducedMotion();

  const [offset, setOffset] = useState(0);
  const [isDragging, setDragging] = useState(false);
  const [isClosing, setClosing] = useState(false);

  const start = useRef<{ x: number; y: number; time: number; id: number } | null>(null);
  const last = useRef<{ y: number; time: number } | null>(null);
  const decided = useRef(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Незакрытый жест не должен пережить размонтирование: таймер вызвал бы
  // `onDismiss` у того, кого уже нет.
  useEffect(
    () => () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
    },
    []
  );

  // Выключение жеста (например, окно стало широким) обязано вернуть слой на
  // место: иначе он останется сдвинутым, и уехать обратно будет нечем.
  useEffect(() => {
    if (!enabled) {
      setOffset(0);
      setDragging(false);
      setClosing(false);
      start.current = null;
      decided.current = false;
    }
  }, [enabled]);

  const reset = useCallback(() => {
    start.current = null;
    last.current = null;
    decided.current = false;
    setDragging(false);
    setOffset(0);
  }, []);

  const finish = useCallback(() => {
    if (prefersReducedMotion) {
      reset();
      onDismiss();
      return;
    }
    // Слой доезжает до края сам, и только потом окно снимается: иначе
    // потянутый вниз лист исчезал бы одним кадром на полпути.
    setDragging(false);
    setClosing(true);
    setOffset(typeof window === 'undefined' ? thresholdPx * 4 : window.innerHeight);
    exitTimer.current = setTimeout(() => {
      setClosing(false);
      setOffset(0);
      start.current = null;
      decided.current = false;
      onDismiss();
    }, SWIPE_DISMISS_EXIT_MS);
  }, [onDismiss, prefersReducedMotion, reset, thresholdPx]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || isClosing) return;
      // Вторым пальцем щипают, а не закрывают.
      if (!event.isPrimary) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(IGNORED_ORIGIN)) return;

      start.current = { x: event.clientX, y: event.clientY, time: event.timeStamp, id: event.pointerId };
      last.current = { y: event.clientY, time: event.timeStamp };
      decided.current = false;
    },
    [enabled, isClosing]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const origin = start.current;
      if (!origin || origin.id !== event.pointerId) return;

      const dy = event.clientY - origin.y;
      const dx = event.clientX - origin.x;

      if (!decided.current) {
        if (Math.abs(dy) < INTENT_SLOP_PX && Math.abs(dx) < INTENT_SLOP_PX) return;
        // Вверх и вбок — не наш жест, и перехватывать его нельзя: под пальцем
        // может оказаться что-то своё.
        if (dy <= 0 || Math.abs(dy) < Math.abs(dx) * VERTICAL_INTENT_RATIO) {
          start.current = null;
          return;
        }
        decided.current = true;
        setDragging(true);
        // С этого мгновения движение наше целиком, даже если палец уйдёт с
        // элемента: иначе слой застрянет на полпути. Захват бросает исключение
        // на указателе, которого браузер уже не считает живым, — и уронил бы
        // вместе с собой весь жест, поэтому отказ здесь ничего не значит.
        try {
          (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        } catch {
          /* Указатель отпущен раньше, чем мы решили: жест доедет и без захвата. */
        }
      }

      last.current = { y: event.clientY, time: event.timeStamp };
      setOffset(Math.max(0, dy));
    },
    []
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const origin = start.current;
      if (!origin || origin.id !== event.pointerId) return;
      if (!decided.current) {
        reset();
        return;
      }

      const dy = Math.max(0, event.clientY - origin.y);
      const previous = last.current;
      const elapsed = previous ? event.timeStamp - previous.time : 0;
      const velocity = elapsed > 0 ? (event.clientY - previous!.y) / elapsed : 0;

      if (dy >= thresholdPx || velocity >= SWIPE_DISMISS_VELOCITY) {
        finish();
        return;
      }
      // Не дотянул — слой возвращается на место, и это ответ «не закрыл»,
      // а не молчание.
      reset();
    },
    [finish, reset, thresholdPx]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      if (start.current && start.current.id !== event.pointerId) return;
      reset();
    },
    [reset]
  );

  return {
    offset,
    isDragging,
    isClosing,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
  };
}
