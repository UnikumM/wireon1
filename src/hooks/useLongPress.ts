import { useCallback, useEffect, useRef } from 'react';

/**
 * Долгое нажатие — второй способ добраться до действий над строкой.
 *
 * Зачем. До этого единственным входом в меню трека была кнопка «…» размером
 * 32×32 в правом углу строки. На телефоне это худшая мишень из возможных: мала
 * сама по себе и стоит там, куда большой палец дотягивается последним. Долгое
 * нажатие превращает в мишень **всю строку** — 328×72 вместо 32×32, — и делает
 * это тем жестом, которым на телефоне и открывают действия везде.
 *
 * Кнопка при этом остаётся: жест не находят, если о нём не знают, и он
 * недоступен клавиатуре. Это второй вход, а не замена первому.
 */

/**
 * Сколько держать. 500 мс — то же, что у Android по умолчанию: короче начинает
 * срабатывать при обычном нажатии, длиннее ощущается как зависание.
 */
export const LONG_PRESS_MS = 500;

/**
 * Насколько можно сместиться, оставаясь «нажатием». Палец не стоит неподвижно
 * никогда; всё, что больше, — это прокрутка, и её перехватывать нельзя.
 */
const MOVE_TOLERANCE_PX = 10;

export interface LongPressOptions {
  onLongPress: () => void;
  enabled?: boolean;
}

export interface LongPressResult {
  handlers: {
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
    onContextMenu: (event: React.MouseEvent) => void;
  };
  /** Сработало ли долгое нажатие. Нужно, чтобы отпускание не сыграло трек. */
  consumedRef: React.MutableRefObject<boolean>;
}

export function useLongPress({ onLongPress, enabled = true }: LongPressOptions): LongPressResult {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const consumedRef = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  // Отсчёт не должен пережить размонтирование: сработавший таймер позвал бы
  // обработчик у строки, которой уже нет в списке.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || !event.isPrimary) return;
      // Мышь сюда не приглашена: на ПК долгое нажатие — это просто задержка
      // перед кликом, и меню, всплывающее само, читалось бы как сбой.
      if (event.pointerType === 'mouse') return;
      consumedRef.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        consumedRef.current = true;
        timer.current = null;
        callback.current();
      }, LONG_PRESS_MS);
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const start = origin.current;
      if (!start) return;
      const moved =
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE_PX;
      if (moved) clear();
    },
    [clear]
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      // Android сам зовёт контекстное меню после долгого удержания. Своё уже
      // открыто, и системное поверх него — лишний слой, который человек не
      // просил.
      if (consumedRef.current) event.preventDefault();
    },
    []
  );

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu
    },
    consumedRef
  };
}
