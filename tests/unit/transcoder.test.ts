/**
 * Сжатие офлайн-библиотеки (`electron/transcoder.ts`).
 *
 * Проверяется здесь ровно то, что может сломаться тихо: аргументы, уезжающие в
 * дочерний процесс (битрейт и расширение приходят из renderer), возврат
 * оригинала вместо исключения на каждом виде сбоя — иначе офлайн-очередь
 * встанет на первом же битом файле, — и уборка временных файлов, которых на
 * диске остаётся по размеру трека каждый.
 *
 * Настоящий ffmpeg не запускается: подменён запуск процесса, а сам диск
 * настоящий — временный каталог, чтобы уборка проверялась не на моке.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  AudioTranscoder,
  ALLOWED_BITRATES_KBPS,
  DEFAULT_BITRATE_KBPS,
  MAX_TRANSCODE_INPUT_BYTES,
  normalizeBitrate,
  normalizeSourceExt
} from '../../electron/transcoder';

const FFMPEG = path.join('C:', 'app', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

/** Входные байты: любые, лишь бы отличались от «сжатых» размером. */
const INPUT = new Uint8Array(4096).fill(3);

let workRoot: string;

/** Аргумент ffmpeg по имени флага: `-b:a` → `96k`. */
function argAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

/**
 * Собирает перекодировщик с подменённым запуском ffmpeg.
 *
 * `behaviour` получает аргументы и решает судьбу выходного файла: по умолчанию
 * пишет «сжатый» результат вдвое меньше входа.
 */
function makeTranscoder(
  behaviour?: (args: string[]) => void | Promise<void>,
  overrides: { exists?: boolean; suffix?: string } = {}
) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const run = vi.fn(async (_exe: string, args: string[]) => {
    calls.push(args);
    if (behaviour) {
      await behaviour(args);
      return;
    }
    writeFileSync(args[args.length - 1], new Uint8Array(1024).fill(9));
  });

  const transcoder = new AudioTranscoder({
    ffmpegPath: FFMPEG,
    tempDir: workRoot,
    log: (message) => logs.push(message),
    existsImpl: (() => overrides.exists !== false) as never,
    runFfmpeg: run,
    uniqueSuffix: () => overrides.suffix ?? 'fixed'
  });

  return { transcoder, run, calls, logs };
}

/** Что осталось в рабочем каталоге после перекодирования. */
function leftovers(): string[] {
  const dir = path.join(workRoot, 'transcode');
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'wireon-transcode-'));
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('normalizeBitrate', () => {
  it('accepts every offered bitrate as is', () => {
    for (const value of ALLOWED_BITRATES_KBPS) {
      expect(normalizeBitrate(value)).toBe(value);
    }
  });

  it('replaces anything outside the list with the default', () => {
    // Значение уезжает в аргументы дочернего процесса, поэтому «почти
    // подходящее» (320) отвергается так же, как явный мусор.
    for (const value of [320, 0, -96, 96.5, NaN, Infinity, null, undefined, {}, '96; rm -rf /']) {
      expect(normalizeBitrate(value)).toBe(DEFAULT_BITRATE_KBPS);
    }
  });

  it('takes a numeric string, because a <select> hands back strings', () => {
    expect(normalizeBitrate('64')).toBe(64);
  });
});

describe('normalizeSourceExt', () => {
  it('keeps the formats YouTube and SoundCloud actually hand out', () => {
    expect(normalizeSourceExt('m4a')).toBe('m4a');
    expect(normalizeSourceExt('.WEBM')).toBe('webm');
    expect(normalizeSourceExt('mp3')).toBe('mp3');
  });

  it('falls back to bin instead of letting a path escape into the filename', () => {
    for (const value of ['../../evil', 'm4a/../..', 'exe', '', null, undefined, 42]) {
      expect(normalizeSourceExt(value)).toBe('bin');
    }
  });
});

describe('AudioTranscoder', () => {
  it('compresses to opus at the asked bitrate and reports the saving', async () => {
    const { transcoder, calls } = makeTranscoder();

    const result = await transcoder.transcode({ data: INPUT, bitrateKbps: 64, sourceExt: 'm4a' });

    expect(result.compressed).toBe(true);
    expect(result.format).toBe('opus');
    expect(result.bitrate).toBe(64);
    expect(result.data.byteLength).toBe(1024);

    const args = calls[0];
    expect(argAfter(args, '-c:a')).toBe('libopus');
    expect(argAfter(args, '-b:a')).toBe('64k');
    // Видеодорожка в аудиофайле сделала бы его невоспроизводимым в <audio>.
    expect(args).toContain('-vn');
    // Ogg, а не сырой opus: Chromium играет только контейнер.
    expect(argAfter(args, '-f')).toBe('ogg');
    expect(args[args.length - 1].endsWith('.opus')).toBe(true);
  });

  it('never lets a renderer-supplied bitrate reach ffmpeg unchecked', async () => {
    const { transcoder, calls } = makeTranscoder();

    await transcoder.transcode({ data: INPUT, bitrateKbps: 999 as number, sourceExt: 'm4a' });

    expect(argAfter(calls[0], '-b:a')).toBe(`${DEFAULT_BITRATE_KBPS}k`);
  });

  it('never lets a renderer-supplied extension reach the temp path', async () => {
    const { transcoder, calls } = makeTranscoder();

    await transcoder.transcode({ data: INPUT, sourceExt: '../../../etc/passwd' });

    const input = argAfter(calls[0], '-i')!;
    expect(input.endsWith('.bin')).toBe(true);
    // Путь остался внутри рабочего каталога — обход каталога не удался.
    expect(path.resolve(input).startsWith(path.resolve(workRoot))).toBe(true);
  });

  it('hands back the original when ffmpeg fails instead of failing the download', async () => {
    // Сохранить трек несжатым лучше, чем не сохранить: очередь идёт дальше.
    const { transcoder, logs } = makeTranscoder(() => {
      throw new Error('Invalid data found when processing input');
    });

    const result = await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(result.compressed).toBe(false);
    expect(result.data).toBe(INPUT);
    expect(result.format).toBe('m4a');
    expect(result.reason).toContain('Invalid data');
    expect(logs.join(' ')).toContain('не удалось сжать');
  });

  it('hands back the original when ffmpeg writes nothing', async () => {
    // Процесс завершился нулём, а файла нет: readFileSync бросит — и это тоже
    // не должно долетать до вызывающего.
    const { transcoder } = makeTranscoder(() => {});

    const result = await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(result.compressed).toBe(false);
    expect(result.data).toBe(INPUT);
  });

  it('hands back the original when ffmpeg writes an empty file', async () => {
    const { transcoder } = makeTranscoder((args) => {
      writeFileSync(args[args.length - 1], new Uint8Array(0));
    });

    const result = await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(result.compressed).toBe(false);
    expect(result.data).toBe(INPUT);
    expect(result.reason).toContain('пустой файл');
  });

  it('keeps the original when compression did not actually make it smaller', async () => {
    // Так бывает на уже сжатом источнике: 160k из 96k opus только раздувает.
    const { transcoder, logs } = makeTranscoder((args) => {
      writeFileSync(args[args.length - 1], new Uint8Array(INPUT.byteLength + 10).fill(1));
    });

    const result = await transcoder.transcode({ data: INPUT, bitrateKbps: 160, sourceExt: 'opus' });

    expect(result.compressed).toBe(false);
    expect(result.data).toBe(INPUT);
    expect(result.reason).toContain('не уменьшило');
    expect(logs.join(' ')).toContain('не уменьшил файл');
  });

  it('does not spawn ffmpeg at all when the binary is missing', async () => {
    const { transcoder, run } = makeTranscoder(undefined, { exists: false });

    const result = await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(run).not.toHaveBeenCalled();
    expect(transcoder.isAvailable()).toBe(false);
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('ffmpeg недоступен');
  });

  it('skips inputs too large to hold in memory twice', async () => {
    const { transcoder, run } = makeTranscoder();
    // Разреженный массив: длина есть, страниц памяти под неё почти нет.
    const huge = { byteLength: MAX_TRANSCODE_INPUT_BYTES + 1 } as Uint8Array;

    const result = await transcoder.transcode({ data: huge, sourceExt: 'm4a' });

    expect(run).not.toHaveBeenCalled();
    expect(result.compressed).toBe(false);
    expect(result.reason).toBe('файл слишком большой');
  });

  it('skips empty input without touching the disk', async () => {
    const { transcoder, run } = makeTranscoder();

    const result = await transcoder.transcode({ data: new Uint8Array(0) });

    expect(run).not.toHaveBeenCalled();
    expect(result.compressed).toBe(false);
    expect(leftovers()).toHaveLength(0);
  });

  it('leaves no temp files behind after a success', async () => {
    const { transcoder } = makeTranscoder();

    await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(leftovers()).toHaveLength(0);
  });

  it('leaves no temp files behind after a failure either', async () => {
    // Иначе первая же ошибка оставляет на диске мусор размером с трек, и так
    // до конца жизни установки — офлайн-лимит при этом ничего не знает.
    const { transcoder } = makeTranscoder((args) => {
      writeFileSync(args[args.length - 1], new Uint8Array(64).fill(1));
      throw new Error('killed');
    });

    await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(leftovers()).toHaveLength(0);
  });

  it('writes exactly the bytes it was given for ffmpeg to read', async () => {
    let seen: Uint8Array | null = null;
    const { transcoder } = makeTranscoder((args) => {
      seen = new Uint8Array(readFileSync(argAfter(args, '-i')!));
      writeFileSync(args[args.length - 1], new Uint8Array(512).fill(2));
    });

    await transcoder.transcode({ data: INPUT, sourceExt: 'm4a' });

    expect(seen).not.toBeNull();
    expect(Array.from(seen!)).toEqual(Array.from(INPUT));
  });

  it('gives concurrent transcodes separate temp files', async () => {
    // Два трека сжимаются подряд, но пути не должны совпасть: иначе второй
    // затрёт вход первого, и на диск ляжет не тот трек.
    let counter = 0;
    const inputs: string[] = [];
    const transcoder = new AudioTranscoder({
      ffmpegPath: FFMPEG,
      tempDir: workRoot,
      existsImpl: (() => true) as never,
      runFfmpeg: async (_exe, args) => {
        inputs.push(argAfter(args, '-i')!);
        writeFileSync(args[args.length - 1], new Uint8Array(128).fill(1));
      },
      uniqueSuffix: () => `s${++counter}`
    });

    await Promise.all([
      transcoder.transcode({ data: INPUT, sourceExt: 'm4a' }),
      transcoder.transcode({ data: INPUT, sourceExt: 'm4a' })
    ]);

    expect(new Set(inputs).size).toBe(2);
    expect(leftovers()).toHaveLength(0);
  });
});
