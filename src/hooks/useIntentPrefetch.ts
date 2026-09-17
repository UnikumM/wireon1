import { useCallback, useEffect, useRef } from 'react';
import { streamResolver } from '../services/streamResolver';
import { usePlayerStore } from '../store/usePlayerStore';
import type { UnifiedTrack } from '../types/music';

/**
 * Готовит ссылку на трек, пока человек только навёл на него курсор.
 *
 * Разбор ссылки YouTube — секунды: запуск yt-dlp, разбор страницы, проверка
 * ссылки. Замерено 2026-09-17: 3,2–3,8 с на трек. Сам звук потом идёт потоком,
 * частями, так что ждёт человек именно ссылку. Курсор задерживается на строке
 * перед щелчком почти всегда, и если начать разбор в этот момент, к щелчку
 * большая часть уже сделана: нажатие только поднимает приоритет уже идущего
 * разбора (`raiseStreamPriority`).
 *
 * Два ограничения, чтобы не превратить это в нагрузку:
 *   • разбор начинается после {@link INTENT_DWELL_MS} на строке — курсор,
 *     пробежавший по списку, ничего не запускает;
 *   • не больше {@link INTENT_BUDGET} таких разборов за {@link INTENT_WINDOW_MS}.
 *     Фоновых процессов в главном и так два, остальные ждут в очереди — лишние
 *     заявки только удлинили бы её.
 */
export const INTENT_DWELL_MS = 300;
export const INTENT_BUDGET = 4;
export const INTENT_WINDOW_MS = 10_000;

const recentIntents: number[] = [];
const warmedIds = new Set<string>();

/** Для тестов: забыть, что уже грели. */
export function resetIntentPrefetchForTests(): void {
  recentIntents.length = 0;
  warmedIds.clear();
}

/** Запустить подготовку, если бюджет позволяет. Возвращает, запустилась ли. */
export function warmTrack(track: UnifiedTrack | null | undefined, now: number = Date.now()): boolean {
  if (!track?.id || warmedIds.has(track.id)) return false;
  if (usePlayerStore.getState().currentTrack?.id === track.id) return false;

  while (recentIntents.length > 0 && now - recentIntents[0] > INTENT_WINDOW_MS) recentIntents.shift();
  if (recentIntents.length >= INTENT_BUDGET) return false;

  recentIntents.push(now);
  warmedIds.add(track.id);
  // Ссылка живёт часы, но не вечно: через десять минут можно греть снова.
  setTimeout(() => warmedIds.delete(track.id), 10 * 60 * 1000);
  try {
    streamResolver.prefetch(track);
  } catch (err) {
    console.warn('[useIntentPrefetch] подготовка не запустилась:', err);
  }
  return true;
}

/** Обработчики наведения для строки трека. `enabled: false` — на телефоне. */
export function useIntentPrefetch(track: UnifiedTrack, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onIntentStart = useCallback(() => {
    if (!enabled) return;
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      warmTrack(track);
    }, INTENT_DWELL_MS);
  }, [cancel, enabled, track]);

  return { onIntentStart, onIntentEnd: cancel };
}
