/**
 * Причина несохранённого трека — фразой для человека (4.0.2).
 *
 * В настройках офлайна стоял сырой вывод yt-dlp с путями внутри APK и ссылками
 * на вики; блок к тому же не переносился и уезжал за экран.
 */

import { describe, it, expect } from 'vitest';
import { describeOfflineFailure, failureCode, isBlockingFailure } from '../../src/services/offlineErrors';

describe('describeOfflineFailure', () => {
  it('коды YouTube превращаются в короткие фразы без советов про ПК', () => {
    expect(describeOfflineFailure(new Error('YT_BOT_CHECK: что угодно'))).toBe(
      'YouTube попросил подтвердить, что запросы идут не от робота. Попробуем позже.'
    );
    expect(describeOfflineFailure(new Error('YT_NETWORK: нет связи с YouTube'))).toMatch(/Нет связи с YouTube/);
    expect(describeOfflineFailure(new Error('YT_PRIVATE: Private video'))).toMatch(/приватн/i);
  });

  it('код читается и за обёрткой IPC', () => {
    const wrapped = new Error("Error invoking remote method 'resolve-youtube-stream': Error: YT_BOT_CHECK: bot");
    expect(failureCode(wrapped)).toBe('YT_BOT_CHECK');
    expect(isBlockingFailure(wrapped)).toBe(true);
    expect(isBlockingFailure(new Error('YT_PRIVATE: x'))).toBe(false);
  });

  it('свои русские сообщения хранилища остаются как есть', () => {
    const own = '«Hot Together»: свой источник не отдал запись, а замену сохранять не будем';
    expect(describeOfflineFailure(new Error(own))).toBe(own);
  });

  it('незнакомый длинный отказ не попадает в настройки дословно', () => {
    const raw =
      'WARNING: ffmpeg location /data/app/~~x/lib/arm64/libffmpeg.so does not exist! ERROR: [youtube] abc: something odd, see https://github.com/yt-dlp/yt-dlp/wiki';
    const text = describeOfflineFailure(new Error(raw));
    expect(text).toBe('Источник не отдал запись. Попробуем позже.');
  });
});
