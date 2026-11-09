import { useCallback, useEffect, useRef, useState } from 'react';
import { scrubPosition, scrubRate, type ScrubRate } from '../../../services/scrubbing';

/**
 * Точная перемотка по обложке на сцене телефона.
 *
 * Палец ведёт по обложке влево-вправо — время идёт за ним; уходит ниже —
 * идёт медленнее (зоны считает services/scrubbing). Пока палец на экране,
 * позиция живёт здесь, в хуке, и плеер её не видит: перемотка одна, на
 * отпускании. Иначе каждое движение дёргало бы поток, а на YouTube и HLS
 * перемотка — это новый запрос за куском.
 *
 * Как жест разводится с соседями:
 *
 * - тап по обложке — указатель опустился и поднялся раньше `SCRUB_HOLD_MS`,
 *   не сдвинувшись на `SCRUB_INTENT_PX`. Хук его не трогает, клик проходит;
 * - перемотка начинается либо удержанием `SCRUB_HOLD_MS` на месте, либо сразу
 *   горизонтальным сдвигом на `SCRUB_INTENT_PX` — ждать не нужно, когда
 *   намерение и так понятно;
 * - вертикальное движение до того, как жест признан, — не наш случай:
 *   отсчёт удержания сбрасывается, и указатель отдаётся прокрутке и свайпу
 *   закрытия сцены (тот живёт на ухватке и шапке, а не на обложке, но сцена
 *   ещё и прокручивается на невысоком экране). После признания вертикаль —
 *   уже выбор зоны скорости, и слой держит указатель захватом;
 * - `pointercancel` (система забрала указатель) — отмена без перемотки.
 */

/** Сколько держать палец на месте, чтобы перемотка началась без движения. */
export const SCRUB_HOLD_MS = 150;

/** Горизонтальный сдвиг, с которого перемотка начинается сразу, без удержания. */
export const SCRUB_INTENT_PX = 12;

export interface ArtworkScrubOptions {
  /** На ПК жеста нет: там колесо и ползунок. Выключенный хук не держит состояния. */
  enabled: boolean;
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}

export interface ArtworkScrubResult {
  /** Палец на обложке, жест признан, оверлей показан. */
  isScrubbing: boolean;
  /** Позиция под пальцем; вне жеста — текущее время плеера. */
  position: number;
  rate: ScrubRate;
  /** Насколько ушли от точки начала жеста, секунды со знаком. */
  delta: number;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  };
}

interface Gesture {
  id: number;
  originX: number;
  originY: number;
  lastX: number;
  width: number;
  height: number;
  element: HTMLElement;
  /** Жест признан перемоткой: удержанием или горизонтальным сдвигом. */
  armed: boolean;
  /** После признания палец хоть раз двинулся — иначе перематывать не к чему. */
  moved: boolean;
  startPosition: number;
  position: number;
  rate: ScrubRate;
}

interface Live {
  position: number;
  rate: ScrubRate;
  delta: number;
}

/** Размер зоны жеста; без измерения (jsdom, нулевой элемент) — размеры окна. */
function measure(element: HTMLElement): { width: number; height: number } {
  const rect = element.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : typeof window === 'undefined' ? 1 : window.innerWidth;
  const height = rect.height > 0 ? rect.height : width;
  return { width, height };
}

export function useArtworkScrub({ enabled, currentTime, duration, onSeek }: ArtworkScrubOptions): ArtworkScrubResult {
  const [live, setLive] = useState<Live | null>(null);

  const gesture = useRef<Gesture | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Отпускание после перемотки рождает клик — его надо проглотить. */
  const swallowClick = useRef(false);

  // Время и колбэк читаются в момент события, а не замыкаются при подписке:
  // `timeupdate` приходит четыре раза в секунду, и пересоздавать обработчики
  // ради него незачем.
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const seekRef = useRef(onSeek);
  seekRef.current = onSeek;

  const clearHold = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearHold();
    const current = gesture.current;
    if (current?.armed) {
      try {
        current.element.releasePointerCapture?.(current.id);
      } catch {
        /* Указателя уже нет — захват снят браузером. */
      }
    }
    gesture.current = null;
    setLive(null);
  }, [clearHold]);

  // Незавершённый отсчёт не должен пережить размонтирование сцены.
  useEffect(() => reset, [reset]);

  // Жест выключили посреди ведения (окно стало широким) — всё на место.
  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const arm = useCallback(() => {
    const current = gesture.current;
    if (!current || current.armed) return;
    clearHold();
    current.armed = true;
    current.startPosition = Math.max(0, Math.min(timeRef.current, durationRef.current));
    current.position = current.startPosition;
    current.rate = 1;
    // С этого мгновения движение наше целиком, даже если палец уйдёт с обложки
    // вниз, в точную зону. Отказ захвата жест не роняет — см. useSwipeDismiss.
    try {
      current.element.setPointerCapture?.(current.id);
    } catch {
      /* Указатель отпущен раньше, чем мы решили: жест доедет и без захвата. */
    }
    setLive({ position: current.position, rate: 1, delta: 0 });
  }, [clearHold]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled || !event.isPrimary || gesture.current) return;
      // Без длительности перематывать некуда: поток ещё не сообщил, сколько в нём.
      if (!(durationRef.current > 0)) return;
      const element = event.currentTarget;
      const { width, height } = measure(element);
      gesture.current = {
        id: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        lastX: event.clientX,
        width,
        height,
        element,
        armed: false,
        moved: false,
        startPosition: 0,
        position: 0,
        rate: 1
      };
      clearHold();
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        arm();
      }, SCRUB_HOLD_MS);
    },
    [arm, clearHold, enabled]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;

      if (!current.armed) {
        const dx = event.clientX - current.originX;
        const dy = event.clientY - current.originY;
        if (Math.abs(dx) >= SCRUB_INTENT_PX && Math.abs(dx) > Math.abs(dy)) {
          arm();
          current.lastX = current.originX;
        } else {
          // Вертикаль раньше признания — прокрутка или свайп, не перемотка.
          if (Math.abs(dy) >= SCRUB_INTENT_PX) {
            clearHold();
            gesture.current = null;
          }
          return;
        }
      }

      const rate = scrubRate(event.clientY - current.originY, current.height);
      const dx = event.clientX - current.lastX;
      current.lastX = event.clientX;
      if (dx !== 0) current.moved = true;
      current.rate = rate;
      current.position = scrubPosition(current.position, dx, current.width, durationRef.current, rate);
      setLive({ position: current.position, rate, delta: current.position - current.startPosition });
    },
    [arm, clearHold]
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      if (current.armed) {
        swallowClick.current = true;
        // Одна перемотка на жест — и только если палец куда-то вёл.
        if (current.moved) seekRef.current(current.position);
      }
      reset();
    },
    [reset]
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      // Систему перебить нельзя: указатель забрали — отменяем без перемотки.
      reset();
    },
    [reset]
  );

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLElement>) => {
    // Удержание на картинке иначе открывает системное меню «сохранить изображение».
    if (gesture.current) event.preventDefault();
  }, []);

  return {
    isScrubbing: live !== null,
    position: live ? live.position : currentTime,
    rate: live ? live.rate : 1,
    delta: live ? live.delta : 0,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenu }
  };
}
