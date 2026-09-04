import { describe, it, expect, afterEach, vi } from 'vitest';
import '../setup';
import {
  OnDeviceError,
  extensionOf,
  pickAudio,
  resetInnertube,
  resolveOnDevice,
  setInnertubeFactory
} from '../../src/services/youtubeOnDevice';

/**
 * Разбор на самом телефоне — единственный путь, которым мобильная сборка вообще
 * получает звук: ссылка, добытая сервером, подписана вместе с его адресом и с
 * телефона отвечает 403.
 *
 * Поэтому проверяется здесь не «зовёт библиотеку», а то, чем этот путь ломается
 * молча: выбранная дорожка без звука (трафик за кадры, которых никто не видит),
 * потерянный код отказа (вместо совета — «что-то пошло не так») и запомненная
 * неудача старта (одна пропавшая сеть означала бы «музыки не будет до
 * перезапуска приложения»).
 */

const VIDEO_ID = 'dQw4w9WgXcQ';
const URL_WITH_EXPIRY =
  'https://rr1---sn-x.googlevideo.com/videoplayback?expire=1900000000&itag=140';

function stream(formats: unknown[], status = 'OK', reason?: string) {
  return {
    playability_status: { status, reason },
    streaming_data: { adaptive_formats: formats, formats: [] }
  };
}

function factoryReturning(info: unknown) {
  return async () => ({
    getBasicInfo: async () => info,
    session: { player: {} }
  });
}

afterEach(() => {
  resetInnertube();
  vi.restoreAllMocks();
});

describe('youtubeOnDevice: выбор дорожки', () => {
  it('берёт самый жирный звук без картинки', () => {
    const picked = pickAudio([
      { has_audio: true, has_video: false, bitrate: 64000, url: 'a' },
      { has_audio: true, has_video: false, bitrate: 130000, url: 'b' },
      { has_audio: true, has_video: false, bitrate: 96000, url: 'c' }
    ]);
    expect(picked.url).toBe('b');
  });

  it('дорожку с картинкой не берёт даже когда она единственная', () => {
    // `chooseFormat` из библиотеки в этом случае отдал бы видео. На телефоне
    // это мегабайты за кадры, которых никто не увидит.
    expect(pickAudio([{ has_audio: true, has_video: true, bitrate: 500000, url: 'v' }])).toBeNull();
  });

  it('дорожку без звука не берёт', () => {
    expect(pickAudio([{ has_audio: false, has_video: false, bitrate: 1, url: 'x' }])).toBeNull();
  });

  it('дорожку без адреса и без шифра не берёт', () => {
    expect(pickAudio([{ has_audio: true, has_video: false, bitrate: 130000 }])).toBeNull();
  });

  it('зашифрованная дорожка — кандидат: адрес появится после расшифровки', () => {
    const picked = pickAudio([
      { has_audio: true, has_video: false, bitrate: 130000, signature_cipher: 's=...' }
    ]);
    expect(picked).not.toBeNull();
  });

  it('пустой список — не отказ, а отсутствие кандидатов', () => {
    expect(pickAudio([])).toBeNull();
    expect(pickAudio(undefined as unknown as unknown[])).toBeNull();
  });
});

describe('youtubeOnDevice: расширение по типу', () => {
  it('mp4 читается как m4a', () => {
    expect(extensionOf('audio/mp4; codecs="mp4a.40.2"')).toBe('m4a');
  });

  it('webm читается как webm', () => {
    expect(extensionOf('audio/webm; codecs="opus"')).toBe('webm');
  });

  it('незнакомое считаем m4a: так его поймёт больше проигрывателей', () => {
    expect(extensionOf(undefined)).toBe('m4a');
    expect(extensionOf('нечто/странное')).toBe('m4a');
  });
});

describe('youtubeOnDevice: ссылка', () => {
  it('отдаёт адрес, формат и битрейт в килобитах', async () => {
    setInnertubeFactory(
      factoryReturning(
        stream([
          {
            has_audio: true,
            has_video: false,
            bitrate: 129495,
            mime_type: 'audio/mp4; codecs="mp4a.40.2"',
            url: URL_WITH_EXPIRY
          }
        ])
      )
    );

    const got = await resolveOnDevice(VIDEO_ID);
    expect(got.streamUrl).toBe(URL_WITH_EXPIRY);
    expect(got.format).toBe('m4a');
    // Библиотека считает в битах, всё остальное приложение — в килобитах.
    // Без деления экран качества показал бы «129495 кбит/с».
    expect(got.bitrate).toBe(129);
    expect(got.expiresAt).toBe(1900000000 * 1000);
  });

  it('расшифровывает подпись, когда готового адреса нет', async () => {
    const decipher = vi.fn().mockReturnValue(URL_WITH_EXPIRY);
    setInnertubeFactory(
      factoryReturning(
        stream([
          {
            has_audio: true,
            has_video: false,
            bitrate: 130000,
            mime_type: 'audio/webm',
            signature_cipher: 's=abc',
            decipher
          }
        ])
      )
    );

    const got = await resolveOnDevice(VIDEO_ID);
    expect(decipher).toHaveBeenCalled();
    expect(got.streamUrl).toBe(URL_WITH_EXPIRY);
    expect(got.format).toBe('webm');
  });

  it('пустой videoId отсекается до всякой работы', async () => {
    await expect(resolveOnDevice('')).rejects.toThrow(/^YT_BAD_ID:/);
  });
});

describe('youtubeOnDevice: отказы говорят кодом', () => {
  it('возрастное ограничение получает свой код, а не «не вышло»', async () => {
    setInnertubeFactory(
      factoryReturning(stream([], 'AGE_VERIFICATION_REQUIRED', 'Sign in to confirm your age'))
    );
    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/^YT_AGE_RESTRICTED: Sign in/);
  });

  it('снятое видео — YT_UNAVAILABLE', async () => {
    setInnertubeFactory(factoryReturning(stream([], 'UNPLAYABLE', 'Video unavailable')));
    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/^YT_UNAVAILABLE:/);
  });

  it('незнакомое состояние тоже не теряется', async () => {
    setInnertubeFactory(factoryReturning(stream([], 'СОВСЕМ_НОВОЕ', 'что-то новое')));
    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/^YT_UNAVAILABLE: что-то новое/);
  });

  it('ответ без звуковых дорожек — честный отказ, а не тишина', async () => {
    setInnertubeFactory(
      factoryReturning(stream([{ has_audio: true, has_video: true, bitrate: 9, url: 'v' }]))
    );
    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/^YT_NO_AUDIO:/);
  });

  it('падение библиотеки не теряет причину', async () => {
    setInnertubeFactory(async () => {
      throw new Error('сеть пропала');
    });
    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/^YT_ALL_ATTEMPTS_FAILED: сеть пропала/);
  });

  it('неудачный старт не запоминается', async () => {
    // Сеть на телефоне пропадает и возвращается. Запомнив первый отказ, мы
    // получили бы приложение, которое не играет ничего до перезапуска.
    let attempt = 0;
    setInnertubeFactory(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('сеть пропала');
      return {
        getBasicInfo: async () =>
          stream([
            { has_audio: true, has_video: false, bitrate: 128000, mime_type: 'audio/mp4', url: URL_WITH_EXPIRY }
          ]),
        session: { player: {} }
      };
    });

    await expect(resolveOnDevice(VIDEO_ID)).rejects.toThrow(/сеть пропала/);
    const second = await resolveOnDevice(VIDEO_ID);
    expect(second.streamUrl).toBe(URL_WITH_EXPIRY);
    expect(attempt).toBe(2);
  });

  it('код доступен и отдельным полем, не только в тексте', () => {
    const err = new OnDeviceError('YT_LIVE', 'идёт прямой эфир');
    expect(err.code).toBe('YT_LIVE');
    expect(err.message).toBe('YT_LIVE: идёт прямой эфир');
  });
});
