import { useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useUIStore } from '../store/useUIStore';

/** Как часто перепроверять срок жизни токена, пока окно открыто. */
export const SESSION_CHECK_INTERVAL_MS = 60_000;

/**
 * Следит за сессией Discord в течение работы приложения.
 *
 * Токен живёт неделю, а музыкальный плеер запускают и не закрывают: без этой
 * проверки приложение неделю показывает имя и аватар аккаунта, к которому уже
 * нет доступа, и узнаёт об этом только при перезапуске. Проверяем по таймеру и
 * при возвращении к окну — второе важнее, потому что таймеры в свёрнутом окне
 * Chromium придушивает.
 */
export function useSessionWatch(): void {
  useEffect(() => {
    const checkNow = () => {
      const dropped = useAuthStore.getState().checkSessionExpiry();
      if (!dropped) return;
      const message = useAuthStore.getState().error;
      if (message) useUIStore.getState().showToast(message, 'info');
    };

    // Сразу после восстановления сессии: вкладка могла проспать срок истечения.
    checkNow();

    const timer = setInterval(checkNow, SESSION_CHECK_INTERVAL_MS);
    const handleVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') checkNow();
    };

    window.addEventListener('focus', handleVisibility);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', handleVisibility);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);
}
