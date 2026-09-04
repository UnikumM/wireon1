/**
 * Кто мы и где запущены — в одном месте.
 *
 * Версия дублирует `package.json`: собранный рендерер не читает манифест, а
 * подмешивать `define` в Vite ради одной строки дороже, чем проверить
 * совпадение тестом (`tests/unit/appInfo.test.ts`).
 */
import { detectPlatform } from '../services/nativeBridge';

export const APP_VERSION = '1.0.28';

const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
};

/**
 * «Приложение · Windows» для настольной сборки, «Приложение · Android» для APK,
 * «Браузер» для веба.
 *
 * Мобильную сборку от веба отличает не user-agent — в обёртке он такой же, как
 * у обычного Chrome на телефоне, — а объект, который кладёт в окно Capacitor.
 * Строка уходит в отчёт об ошибке, и «Браузер» вместо «Android» отправил бы
 * разбираться не туда.
 */
export function runtimeLabel(): string {
  const platform = typeof window !== 'undefined' ? window.electronAPI?.getPlatform?.() : undefined;
  if (platform) return `Приложение · ${PLATFORM_NAMES[platform] ?? platform}`;
  return detectPlatform() === 'mobile' ? 'Приложение · Android' : 'Браузер';
}

export interface ErrorReportInput {
  /** Сообщение ошибки — единственное, что видно пользователю. */
  message: string;
  /** Стек JS: где именно упало. */
  stack?: string | null;
  /** Стек компонентов React: какой экран упал. */
  componentStack?: string | null;
  /** Что показывалось в момент падения, если это известно. */
  view?: string | null;
}

/**
 * Собирает отчёт, который человек может просто вставить в сообщение.
 *
 * Ничего личного внутрь не попадает: ни токена, ни названий треков, ни ссылок —
 * только версия, среда и стек. Поэтому кнопку «скопировать отчёт» можно нажимать
 * не задумываясь.
 */
export function buildErrorReport(input: ErrorReportInput): string {
  const lines = [
    `Wireon Sounds ${APP_VERSION}`,
    `Среда: ${runtimeLabel()}`,
    typeof navigator !== 'undefined' ? `User agent: ${navigator.userAgent}` : null,
    input.view ? `Экран: ${input.view}` : null,
    '',
    `Ошибка: ${input.message || 'без сообщения'}`
  ];

  if (input.stack) {
    lines.push('', 'Стек:', input.stack.trim());
  }
  if (input.componentStack) {
    lines.push('', 'Компоненты:', input.componentStack.trim());
  }

  return lines.filter((line) => line !== null).join('\n');
}
