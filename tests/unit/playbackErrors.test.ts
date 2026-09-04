/**
 * The playback error mapper: what the player bar actually says when a stream
 * cannot be produced.
 *
 * Two invariants matter here. The copy must never be a bare diagnostic string —
 * that is what `errorDetail` is for — and `canRetry` must be false whenever
 * pressing play again cannot possibly change the outcome, because the UI uses it
 * to decide whether to offer a retry at all.
 */

import { describe, it, expect } from 'vitest';
import { describePlaybackError, unwrapErrorMessage } from '../../src/services/playbackErrors';

describe('unwrapErrorMessage', () => {
  it('снимает префикс, которым Electron оборачивает любой отказ IPC', () => {
    expect(
      unwrapErrorMessage(
        "Error invoking remote method 'resolve-youtube-stream': Error: YT_BOT_CHECK: default: nope"
      )
    ).toBe('YT_BOT_CHECK: default: nope');
  });

  it('снимает и сцепку конструкторов ошибок, и ничего не портит без обёрток', () => {
    expect(unwrapErrorMessage('Error: TypeError: Failed to fetch')).toBe('Failed to fetch');
    expect(unwrapErrorMessage('YT_LIVE: this is a premiere')).toBe('YT_LIVE: this is a premiere');
    expect(unwrapErrorMessage('  просто текст  ')).toBe('просто текст');
  });
});

describe('describePlaybackError', () => {
  it('переводит коды main-процесса, даже пройдя через IPC', () => {
    // Ровно то, что увидел человек в собранном приложении: из-за префикса Electron
    // `YT_*` перестал быть началом строки, и вместо фразы показывалась простыня.
    const viaIpc = describePlaybackError(
      new Error(
        "Error invoking remote method 'resolve-youtube-stream': Error: YT_ALL_ATTEMPTS_FAILED: " +
          "default: ERROR: [youtube] MURua52_YPg: Sign in to confirm you're not a bot"
      ),
      'youtube'
    );

    expect(viaIpc.message).toBe(
      'YouTube не отдал аудио ни одним из способов. Попробуйте другой результат или версию с SoundCloud.'
    );
    expect(viaIpc.message).not.toMatch(/yt-dlp|ERROR|invoking remote method/);
    expect(viaIpc.canRetry).toBe(true);
    // Исходный текст остаётся: он нужен для отчёта об ошибке.
    expect(viaIpc.detail).toMatch(/invoking remote method/);
  });

  it('объясняет проверку «вы не робот» и говорит, что с ней делать', () => {
    const notice = describePlaybackError(
      new Error("YT_BOT_CHECK: default: Sign in to confirm you're not a bot"),
      'youtube'
    );

    expect(notice.message).toMatch(/не от робота/i);
    expect(notice.message).toMatch(/cookies/i);
    // Проверка снимается сама через несколько минут, так что повтор имеет смысл.
    expect(notice.canRetry).toBe(true);
  });

  it('keeps the original message as the detail, whatever it maps to', () => {
    const notice = describePlaybackError(new Error('CDN returned 403 Forbidden'));
    expect(notice.detail).toBe('CDN returned 403 Forbidden');
    expect(notice.message).not.toBe(notice.detail);
  });

  it('reports being offline before anything else', () => {
    // A dead connection produces every other symptom too, so it has to win.
    const notice = describePlaybackError(new Error('TypeError: Failed to fetch'));
    expect(notice.message).toMatch(/нет соединения/i);
    expect(notice.canRetry).toBe(true);
  });

  it('separates a timeout from an outage', () => {
    expect(describePlaybackError(new Error('The operation was aborted')).message).toMatch(
      /слишком долго не отвечает/i
    );
    expect(describePlaybackError(new Error('request timed out after 6000ms')).canRetry).toBe(true);
  });

  it('explains a DRM-only SoundCloud upload and refuses to suggest a retry', () => {
    const notice = describePlaybackError(
      new Error(
        'SoundCloud track 284056452 is only offered as DRM-protected audio (cbc-encrypted-hls), which cannot be played here'
      )
    );
    expect(notice.message).toMatch(/в защищённом виде/i);
    expect(notice.message).not.toMatch(/cbc-encrypted-hls/);
    expect(notice.canRetry).toBe(false);
  });

  it('turns an exhausted transcoding list into one sentence', () => {
    // The thrown message lists every variant and status code. Useful in a bug
    // report, unreadable in a player bar.
    const notice = describePlaybackError(
      new Error(
        'SoundCloud track 254112221: no transcoding produced a playable URL (hls/mp3_1_0: HTTP 404; progressive/mp3_1_0: HTTP 404)'
      )
    );
    expect(notice.message).toMatch(/ограничение лейбла или региона/i);
    expect(notice.message).not.toMatch(/HTTP 404/);
    expect(notice.canRetry).toBe(false);
    expect(notice.detail).toMatch(/hls\/mp3_1_0/);
  });

  it('names HLS when this build cannot play it', () => {
    // The real thrown message wraps the generic "nothing resolved" tail, so this
    // is also the precedence check: the HLS prefix has to win.
    const notice = describePlaybackError(
      new Error(
        'SoundCloud HLS playback unavailable: track 987654: no transcoding produced a playable URL ' +
          '(hls/mp3_1_0: HLS is not playable in this environment)'
      )
    );
    expect(notice.message).toMatch(/HLS/);
    expect(notice.message).not.toMatch(/лейбла или региона/);
    expect(notice.canRetry).toBe(false);
  });

  it('suggests another result when YouTube yields no audio', () => {
    const notice = describePlaybackError(
      new Error('Unable to resolve audio stream for YouTube video: khnokW3Mw24')
    );
    expect(notice.message).toMatch(/другой результат/i);
    expect(notice.message).not.toMatch(/khnokW3Mw24/);
    expect(notice.canRetry).toBe(true);
  });

  it('treats an expired link as retryable and a removed video as not', () => {
    expect(describePlaybackError(new Error('Stream URL expired')).canRetry).toBe(true);
    expect(describePlaybackError(new Error('HTTP 403 Forbidden')).message).toMatch(/истекла/i);
    expect(describePlaybackError(new Error('Video is unavailable')).canRetry).toBe(false);
    expect(describePlaybackError(new Error('This is a private video')).message).toMatch(
      /недоступно/i
    );
  });

  it('distinguishes rate limiting from a server fault', () => {
    expect(describePlaybackError(new Error('HTTP 429 Too Many Requests')).message).toMatch(
      /ограничивает частоту запросов/i
    );
    expect(describePlaybackError(new Error('HTTP 503 Service Unavailable')).message).toMatch(
      /проблемы/i
    );
  });

  it('reports an unplayable format without offering a retry', () => {
    const notice = describePlaybackError(new Error('MEDIA_ERR_SRC_NOT_SUPPORTED'));
    expect(notice.message).toMatch(/не воспроизводится/i);
    expect(notice.canRetry).toBe(false);
  });

  it('«ни один источник не подошёл» — это про загрузку, а не про формат', () => {
    // Так Chromium отвечает на play(), когда ресурс не загрузился по любой
    // причине: раздача ответила 403, связь оборвалась, ссылка протухла. Пока
    // эта строка вела к фразе про формат, человек на телефоне видел «этот
    // аудиоформат здесь не воспроизводится» на самом обычном m4a — и с
    // пометкой «повторять бессмысленно», хотя повтор как раз помогал: за новой
    // ссылкой идут к другому клиенту YouTube.
    const notice = describePlaybackError(
      new Error('NotSupportedError: Failed to load because no supported source was found.')
    );

    expect(notice.message).not.toMatch(/аудиоформат/i);
    expect(notice.canRetry).toBe(true);
  });

  it('отказ самого элемента тоже даёт повторить', () => {
    const notice = describePlaybackError(new Error('MediaError [4]: MEDIA_ELEMENT_ERROR: Format error'));
    expect(notice.canRetry).toBe(true);
  });

  it('не показывает гонку play() как сбой источника', () => {
    // Это второе, что увидел человек: движок теперь такие отказы глотает сам
    // (audioEngine.ts), но если сообщение придёт откуда-то ещё, оно должно быть
    // про переключение трека, а не про SoundCloud.
    const notice = describePlaybackError(
      new Error('Audio playback failed: The play() request was interrupted by a new load request.'),
      'soundcloud'
    );

    expect(notice.message).toBe('Воспроизведение прервалось при переключении трека. Нажмите play ещё раз.');
    expect(notice.message).not.toMatch(/play\(\)|SoundCloud/);
    expect(notice.canRetry).toBe(true);

    expect(
      describePlaybackError(
        new Error('Audio playback failed: The play() request was interrupted by a call to pause().')
      ).message
    ).toMatch(/при переключении трека/);
  });

  it('names the source in the fallback and still shows the raw text', () => {
    const youtube = describePlaybackError(new Error('something exotic broke'), 'youtube');
    expect(youtube.message).toBe('Не удалось воспроизвести с YouTube. something exotic broke');

    const soundcloud = describePlaybackError(new Error('something exotic broke'), 'soundcloud');
    expect(soundcloud.message).toMatch(/^Не удалось воспроизвести с SoundCloud\./);

    const unknown = describePlaybackError(new Error('something exotic broke'));
    expect(unknown.message).toBe('Не удалось воспроизвести. something exotic broke');
  });

  it('survives being handed a non-Error', () => {
    expect(describePlaybackError('plain string').detail).toBe('plain string');
    expect(describePlaybackError(undefined).detail).toBe('Неизвестная ошибка воспроизведения');
    expect(describePlaybackError(null).message).toMatch(/не удалось воспроизвести/i);
  });
});
