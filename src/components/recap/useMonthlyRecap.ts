import { useCallback, useEffect, useState } from 'react';
import { getAllHistory, getPlayEvents, getSetting, setSetting } from '../../services/db';
import {
  buildMonthlyRecap,
  hasMonthlyRecap,
  monthKey,
  MONTHLY_RECAP_DISMISSED_KEY,
  MonthlyRecap,
  MonthRef,
  previousMonth,
  withinHomeWindow
} from '../../services/monthlyRecap';

/**
 * Собирает рекап за месяц `ref` из базы. `null`, пока читается, и `null`, если
 * месяц пуст или ничего не прочиталось: карточке в обоих случаях показывать нечего.
 *
 * Лента включений читается целиком, а не от начала месяца: «новые исполнители»
 * проверяются по всему, что лента помнит (она сама чистится на четырёхстах днях).
 */
export function useMonthlyRecap(ref: MonthRef | null): MonthlyRecap | null {
  const [recap, setRecap] = useState<MonthlyRecap | null>(null);
  const key = ref ? monthKey(ref) : null;

  useEffect(() => {
    if (!ref) {
      setRecap(null);
      return;
    }
    let alive = true;
    void Promise.all([getPlayEvents(0, 200_000).catch(() => []), getAllHistory().catch(() => [])]).then(
      ([events, history]) => {
        if (!alive) return;
        const built = buildMonthlyRecap({ events, history }, ref);
        setRecap(hasMonthlyRecap(built) ? built : null);
      }
    );
    return () => {
      alive = false;
    };
    // Пересобирать только при смене месяца, а не объекта: ref часто создаётся заново.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return recap;
}

export interface HomeMonthlyRecap {
  recap: MonthlyRecap;
  /** Убрать карточку с главной до следующего месяца. */
  dismiss: () => void;
}

/**
 * Рекап для главной: прошлый месяц, первые семь дней нового, пока не закрыли.
 *
 * Закрытие запоминается в настройках ключом месяца, поэтому в ноябре карточка
 * вернётся сама — с новыми цифрами. «Сейчас» фиксируется на первом рендере:
 * иначе карточка могла бы исчезнуть посреди ночи с первого на восьмое число.
 */
export function useHomeMonthlyRecap(): HomeMonthlyRecap | null {
  const [now] = useState(() => Date.now());
  const inWindow = withinHomeWindow(now);
  const ref = previousMonth(now);
  const key = monthKey(ref);
  const recap = useMonthlyRecap(inWindow ? ref : null);
  // `undefined` — ещё не прочитали; до ответа карточку не показываем, чтобы она не мигнула.
  const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!inWindow) return;
    let alive = true;
    void getSetting<string | null>(MONTHLY_RECAP_DISMISSED_KEY, null)
      .then((value) => {
        if (alive) setDismissed(typeof value === 'string' ? value : null);
      })
      .catch(() => {
        if (alive) setDismissed(null);
      });
    return () => {
      alive = false;
    };
  }, [inWindow]);

  const dismiss = useCallback(() => {
    setDismissed(key);
    void setSetting(MONTHLY_RECAP_DISMISSED_KEY, key).catch((error) => {
      console.warn('[MonthlyRecap] Could not remember the dismissal', error);
    });
  }, [key]);

  if (!inWindow || !recap || dismissed === undefined || dismissed === key) return null;
  return { recap, dismiss };
}
