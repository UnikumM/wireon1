/**
 * Turns a playback failure into one sentence a listener can act on.
 *
 * The strings thrown by the resolvers are diagnostic on purpose — they name the
 * transcoding, the HTTP status and the video id, which is what a bug report
 * needs. Rendered verbatim in the player bar they read like a stack trace, so
 * the store keeps both: this copy for the user, the original for the tooltip and
 * the console.
 *
 * The main process prefixes its failures with a stable `YT_*` code, so those are
 * matched exactly. Everything else is matched on message text, because it comes
 * from three layers (our resolvers, `fetch`, and the media element) and only the
 * resolvers throw anything typed.
 */

export interface PlaybackErrorNotice {
  /** One sentence, no jargon, safe to render. */
  message: string;
  /** False when pressing play again cannot possibly help. */
  canRetry: boolean;
  /** The original message, for the tooltip and for support reports. */
  detail: string;
}

/** Codes emitted by `electron/streamResolver.ts`, mapped to what the user sees. */
const CODE_MESSAGES: ReadonlyArray<[code: string, message: string, canRetry: boolean]> = [
  ['YT_AGE_RESTRICTED', 'Видео с возрастным ограничением — YouTube не отдаёт его без входа в аккаунт.', false],
  ['YT_PRIVATE', 'Это приватное видео, доступа к нему нет.', false],
  ['YT_GEO_BLOCKED', 'Трек заблокирован в вашем регионе. Попробуйте другую версию или SoundCloud.', false],
  ['YT_UNAVAILABLE', 'Видео удалено или больше недоступно на YouTube.', false],
  ['YT_LIVE', 'Это прямая трансляция — её нельзя воспроизвести как трек.', false],
  ['YT_BINARY_MISSING', 'Не найден yt-dlp. Переустановите приложение — без него YouTube не работает.', false],
  ['YT_NO_AUDIO', 'У этого видео нет пригодной аудиодорожки.', false],
  [
    'YT_BOT_CHECK',
    'YouTube требует подтвердить, что запросы идут не от робота. Подождите пару минут или разрешите в настройках («Диагностика воспроизведения») брать cookies из браузера, где вы вошли в YouTube.',
    true
  ],
  ['YT_ALL_ATTEMPTS_FAILED', 'YouTube не отдал аудио ни одним из способов. Попробуйте другой результат или версию с SoundCloud.', true],
  ['YT_NETWORK', 'Нет связи с YouTube. Проверьте интернет и попробуйте снова.', true]
];

/**
 * Снимает обёртки, которыми ошибка обрастает по пути из main-процесса.
 *
 * Electron дописывает к любому отказу IPC свой префикс
 * (`Error invoking remote method 'resolve-youtube-stream': Error: …`), из-за
 * которого `YT_*` перестаёт быть началом строки — и вместо понятной фразы
 * человек получал дословную простыню от yt-dlp. Разбираем уже развёрнутый
 * текст, а в `detail` оставляем исходный: он нужен для отчёта об ошибке.
 */
export function unwrapErrorMessage(detail: string): string {
  const viaIpc = /invoking remote method\s+'[^']*':\s*/i.exec(detail);
  const withoutIpc = viaIpc ? detail.slice(viaIpc.index + viaIpc[0].length) : detail;
  // Второй слой: `Error: `, `TypeError: ` и их сцепки перед самим сообщением.
  return withoutIpc.replace(/^(?:[A-Za-z]*Error:\s*)+/, '').trim();
}

export function describePlaybackError(err: unknown, source?: string): PlaybackErrorNotice {
  const detail = err instanceof Error ? err.message : String(err ?? 'Неизвестная ошибка воспроизведения');
  const unwrapped = unwrapErrorMessage(detail);
  const text = unwrapped.toLowerCase();
  const notice = (message: string, canRetry: boolean): PlaybackErrorNotice => ({
    message,
    canRetry,
    detail
  });

  // Codes first: they are unambiguous, unlike the prose that follows them.
  for (const [code, message, canRetry] of CODE_MESSAGES) {
    if (unwrapped.startsWith(code)) {
      return notice(message, canRetry);
    }
  }

  // Offline first: every other diagnosis is a symptom of this one.
  if (/failed to fetch|networkerror|err_internet|err_network|err_name_not_resolved/.test(text)) {
    return notice('Нет соединения. Проверьте интернет и попробуйте снова.', true);
  }

  if (/aborted|abortsignal|timed out|timeout/.test(text)) {
    return notice('Источник слишком долго не отвечает. Попробуйте ещё раз.', true);
  }

  // SoundCloud, label uploads: only DRM transcodings exist.
  if (/drm-protected/.test(text)) {
    return notice(
      'SoundCloud отдаёт этот трек только в защищённом виде — воспроизвести его здесь нельзя. Поищите другую загрузку.',
      false
    );
  }

  // Checked before the generic "nothing resolved" tail below, because that is
  // exactly the string this prefix wraps.
  if (/hls playback unavailable/.test(text)) {
    return notice(
      'Эта загрузка на SoundCloud доступна только адаптивным потоком (HLS), который эта сборка не умеет играть.',
      false
    );
  }

  // Every transcoding was tried and each was refused — almost always a label or
  // region restriction on that particular upload.
  if (/no transcoding produced a playable url/.test(text)) {
    return notice(
      'SoundCloud отказался отдавать эту загрузку — обычно это ограничение лейбла или региона. Попробуйте другую версию.',
      false
    );
  }

  if (/no transcodings found|no valid stream transcoding/.test(text)) {
    return notice('У SoundCloud нет пригодного аудио для этого трека.', false);
  }

  // YouTube: the web fallback cannot produce direct URLs any more, so this is
  // what a browser build hits. In the desktop app it means yt-dlp failed.
  if (/unable to resolve audio stream/.test(text)) {
    return notice(
      'YouTube не отдал аудио для этого видео. Попробуйте другой результат или версию с SoundCloud.',
      true
    );
  }

  if (/is unavailable|private video|removed by the uploader|age-restricted/.test(text)) {
    return notice('Это видео недоступно для воспроизведения.', false);
  }

  if (/\b403\b|forbidden|expired/.test(text)) {
    return notice('Ссылка на поток истекла. Нажмите воспроизведение снова, чтобы обновить её.', true);
  }

  if (/\b429\b|too many requests|rate limit/.test(text)) {
    return notice('Источник ограничивает частоту запросов. Подождите немного и попробуйте снова.', true);
  }

  if (/\b5\d\d\b|server error|bad gateway/.test(text)) {
    return notice('У источника сейчас проблемы. Попробуйте через минуту.', true);
  }

  /*
   * «Ни один источник не подошёл» — это не про формат.
   *
   * Так Chromium отвечает на `play()`, когда ресурс не загрузился, — по любой
   * причине: раздача ответила 403, связь оборвалась, ссылка протухла. Пока эта
   * строка вела к фразе про формат, человек на телефоне видел «этот аудиоформат
   * здесь не воспроизводится» на самом обычном m4a и, что хуже, с пометкой
   * «повторять бессмысленно» — а повтор как раз помогал, потому что за новой
   * ссылкой идут к другому клиенту YouTube.
   */
  if (/no supported source|media_element_error|network state|src attribute/.test(text)) {
    return notice('Не удалось загрузить поток. Пробуем другой источник — нажмите воспроизведение ещё раз.', true);
  }

  // А это уже настоящий формат: дорожка получена, но декодер её не понимает.
  if (/not_supported|src_not_supported|decode|demuxer/.test(text)) {
    return notice('Этот аудиоформат здесь не воспроизводится.', false);
  }

  // Прерванный старт: `src` сменили до того, как play() успел разрешиться. Само
  // по себе это не сбой (движок такие отказы глотает, см. audioEngine.ts), но
  // если такая ошибка всё же дойдёт сюда из другого места, показывать её текст
  // человеку нельзя — он описывает гонку, а не проблему со звуком.
  if (/request was interrupted|interrupted by a (?:new load|call to pause)/.test(text)) {
    return notice('Воспроизведение прервалось при переключении трека. Нажмите play ещё раз.', true);
  }

  const where = source
    ? `Не удалось воспроизвести с ${source === 'youtube' ? 'YouTube' : 'SoundCloud'}`
    : 'Не удалось воспроизвести';
  return notice(`${where}. ${unwrapped}`, true);
}
