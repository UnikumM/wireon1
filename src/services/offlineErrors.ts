/**
 * Почему трек не сохранился — одной фразой для человека.
 *
 * В настройках офлайна в «Последней проблеме» стоял сырой вывод yt-dlp: пути
 * внутри APK, предупреждения про ffmpeg и ссылки на вики — абзац, который к
 * тому же не переносился и уезжал за край экрана. Здесь из отказа остаётся то,
 * с чем можно что-то сделать: подождать, проверить сеть, выбрать другую версию.
 */

import { describePlaybackError, unwrapErrorMessage } from './playbackErrors';

/** Код отказа в начале сообщения: `YT_BOT_CHECK: …` → `YT_BOT_CHECK`. */
export function failureCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(unwrapErrorMessage(raw))?.[1] ?? '';
}

/** Отказы, после которых следующий трек получит тот же ответ: дело не в песне. */
const BLOCKING_CODES = new Set(['YT_BOT_CHECK', 'YT_NETWORK']);

/** Источник сейчас не пускает вообще — молотить очередь дальше бессмысленно. */
export function isBlockingFailure(err: unknown): boolean {
  return BLOCKING_CODES.has(failureCode(err));
}

const OWN_MESSAGES: ReadonlyArray<[string, string]> = [
  ['YT_BOT_CHECK', 'YouTube попросил подтвердить, что запросы идут не от робота. Попробуем позже.'],
  ['YT_NETWORK', 'Нет связи с YouTube. Проверьте интернет — очередь продолжится сама.'],
  ['YT_ALL_ATTEMPTS_FAILED', 'YouTube не отдал запись ни одним из способов. Попробуем позже.'],
  ['YT_BINARY_MISSING', 'На этом устройстве не запустился разбор YouTube. Попробуем через сервер позже.']
];

export function describeOfflineFailure(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const text = unwrapErrorMessage(raw);
  const code = failureCode(err);

  for (const [known, phrase] of OWN_MESSAGES) {
    if (code === known) return phrase;
  }

  // Сообщения самого офлайн-хранилища уже написаны для человека и по-русски
  // («…замену сохранять не будем»): их пересказывать незачем.
  if (!code && /[А-Яа-яЁё]/.test(text) && text.length <= 200 && !/https?:\/\//i.test(text)) return text;

  const notice = describePlaybackError(err).message;
  // Незнакомый отказ `describePlaybackError` отдаёт дословно, со всем хвостом.
  // В настройках такому тексту не место — он остаётся в журнале и в статистике.
  if (notice.includes(text) && (text.length > 120 || /https?:\/\/|\/data\/|WARNING|ERROR/.test(text))) {
    return 'Источник не отдал запись. Попробуем позже.';
  }
  return notice;
}
