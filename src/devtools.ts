import { usePlayerStore } from './store/usePlayerStore';
import { useUIStore } from './store/useUIStore';
import { useLibraryStore } from './store/useLibraryStore';
import { useThemeStore } from './store/useThemeStore';

/**
 * Окно отладки — только в dev-сборке.
 *
 * Зачем: скриншот-тесты (Playwright) и ручная проверка в браузере должны уметь
 * посадить в плеер трек и открыть экран без входа и без сети. Сторы иначе
 * недоступны снаружи. В собранном приложении этого объекта нет вовсе:
 * `import.meta.env.DEV` сборщик вычисляет на этапе сборки, и ветка вырезается.
 */
export function exposeDevtools(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  (window as unknown as { __wireon: unknown }).__wireon = {
    usePlayerStore,
    useUIStore,
    useLibraryStore,
    useThemeStore
  };
}
