/**
 * Отказ синхронизации — одной фразой, за которую можно взяться.
 *
 * Сообщения из адаптера намеренно диагностические: в них код и подробности, и
 * это ровно то, что нужно в отчёте об ошибке. Но в меню аккаунта они выводились
 * как есть, и владелец видел там «Failed to fetch» — три слова, которые браузер
 * выдаёт на любую сетевую беду, от выключенного сервера до запрета источнику.
 * Понять по ним, у кого поломка, невозможно. Здесь тот же приём, что и в
 * `playbackErrors.ts`: человеку — фраза, отчёту — исходная строка.
 */

export interface SyncErrorNotice {
  /** Одно предложение без жаргона. */
  message: string;
  /** Исходная строка — для подсказки и для отчёта. */
  detail: string;
}

const CODE_MESSAGES: ReadonlyArray<[code: string, message: string]> = [
  [
    'WIREON_SYNC_UNREACHABLE',
    'Сервер Wireon не отвечает. Медиатека цела и осталась на устройстве — попробуйте позже.'
  ],
  ['WIREON_SYNC_TIMEOUT', 'Сервер Wireon не ответил вовремя. Попробуйте ещё раз.'],
  ['WIREON_SYNC_OFFLINE', 'Нет подключения к сети — синхронизировать не с чем.'],
  [
    'WIREON_SYNC_NOT_AUTHENTICATED',
    'Синхронизация работает только со входом через Discord — сервер иначе не знает, чья это медиатека.'
  ],
  [
    'WIREON_SYNC_NOT_CONFIGURED',
    'В этой сборке не задан адрес сервера, поэтому медиатека хранится только здесь.'
  ],
  [
    'HTTP_401',
    'Сервер не принял вход через Discord. Войдите заново — скорее всего, сессия истекла.'
  ],
  ['HTTP_403', 'Сервер отказал в доступе к этой медиатеке.'],
  ['HTTP_429', 'Слишком много обращений подряд. Подождите минуту и попробуйте снова.'],
  ['unauthorized', 'Сервер не принял вход через Discord. Войдите заново.'],
  ['rate limited', 'Слишком много обращений подряд. Подождите минуту и попробуйте снова.']
];

/**
 * Английские сообщения самого браузера. Сюда попадает всё, что бросил `fetch`
 * мимо нашего пересказа, — например, отказ на другом слое.
 */
const RAW_MESSAGES: ReadonlyArray<[fragment: string, message: string]> = [
  ['failed to fetch', 'Сервер Wireon не отвечает. Медиатека цела и осталась на устройстве.'],
  ['networkerror', 'Связь с сервером Wireon оборвалась. Попробуйте ещё раз.'],
  ['load failed', 'Связь с сервером Wireon оборвалась. Попробуйте ещё раз.'],
  ['aborted', 'Проверка была прервана.']
];

/** Пересказ отказа. `null` на входе означает «отказа не было». */
export function describeSyncError(raw: string | null | undefined): SyncErrorNotice | null {
  const detail = (raw ?? '').trim();
  if (!detail) return null;

  for (const [code, message] of CODE_MESSAGES) {
    if (detail.startsWith(`${code}:`) || detail === code) return { message, detail };
  }

  const lowered = detail.toLowerCase();
  for (const [fragment, message] of RAW_MESSAGES) {
    if (lowered.includes(fragment)) return { message, detail };
  }

  // Незнакомый отказ: сервер прислал свой текст после кода. Показываем то, что
  // после двоеточия, — оно на русском и написано для человека.
  const afterCode = detail.match(/^[A-Z_0-9]+:\s*(.+)$/);
  if (afterCode) return { message: afterCode[1], detail };

  return { message: detail, detail };
}
