/**
 * Сжатие сохранённого аудио вшитым ffmpeg.
 *
 * Зачем вообще: офлайн-режим складывает на диск то, что человек слушает, а
 * YouTube отдаёт m4a около 128 кбит/с. Пять гигабайт лимита — это примерно
 * восемьсот песен, и упирается в него активный слушатель за пару месяцев.
 * Opus на 96 кбит/с звучит не хуже исходного m4a при примерно вдвое меньшем
 * размере, а на 64 — заметно меньше при цене, которую на телефонных наушниках
 * и в дороге не слышно. Так что дело не в экономии ради экономии: это разница
 * между «влезла часть библиотеки» и «влезла библиотека».
 *
 * Почему в главном процессе. libopus в браузере есть только на приём; в
 * renderer перекодировать нечем — WebCodecs в Electron 43 не даёт кодировщика
 * opus, а wasm-сборка ffmpeg весит столько же, работает в разы медленнее и
 * тянет за собой отдельный CSP. Вшитый бинарник честнее: он и так уже нужен для
 * yt-dlp по соседству.
 *
 * Аргументы ffmpeg собираются только здесь. Из renderer приходят два числа —
 * битрейт (сверяется со списком) и расширение источника (только для имени
 * временного файла, из безопасного алфавита). Ни путей, ни флагов оттуда не
 * принимаем: это дочерний процесс, а не библиотека.
 *
 * Всё, что модуль трогает — запуск процесса и диск — инжектится, поэтому он
 * тестируется без Electron и без настоящего ffmpeg.
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';

/** Битрейты, которые разрешено просить. Всё остальное — попытка подмены. */
export const ALLOWED_BITRATES_KBPS: ReadonlyArray<number> = [64, 96, 128, 160];

/** Что берём, когда пришло что-то не из списка. */
export const DEFAULT_BITRATE_KBPS = 96;

/**
 * Дольше этого перекодирование не длится ни на одной разумной машине: ffmpeg
 * жмёт пятиминутный трек за считаные секунды. Если процесс висит — он завис,
 * и офлайн-очередь не должна вместе с ним.
 */
const TRANSCODE_TIMEOUT_MS = 120_000;

/**
 * Больше этого на вход не берём.
 *
 * Часовой микс в m4a — это уже около 60 МБ, а данные едут через IPC и
 * складываются в память дважды. Такой трек сохраняем как есть: это редкость,
 * и лучше отдать оригинал, чем упасть на выделении памяти.
 */
export const MAX_TRANSCODE_INPUT_BYTES = 96 * 1024 * 1024;

export interface TranscodeRequest {
  data: Uint8Array;
  bitrateKbps?: number;
  /** Расширение источника — только чтобы ffmpeg верно угадал контейнер. */
  sourceExt?: string;
}

export interface TranscodeResult {
  data: Uint8Array;
  /** `opus` — сжали; исходное расширение — вернули как было. */
  format: string;
  bitrate: number;
  /** false — отдали оригинал; причина в {@link TranscodeResult.reason}. */
  compressed: boolean;
  reason?: string;
}

export interface TranscoderDeps {
  /** Путь к вшитому ffmpeg. */
  ffmpegPath: string;
  /** Куда класть временные файлы; обычно userData. */
  tempDir: string;
  log?: (message: string) => void;
  existsImpl?: typeof existsSync;
  /** Запуск ffmpeg. Подменяется в тестах — настоящий кодировщик там не нужен. */
  runFfmpeg?: (exe: string, args: string[]) => Promise<void>;
  /** Счётчик для имён временных файлов: `Date.now()` в тестах неудобен. */
  uniqueSuffix?: () => string;
}

/** Приводит битрейт к разрешённому: чужое число до аргументов не доходит. */
export function normalizeBitrate(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_BITRATE_KBPS;
  return ALLOWED_BITRATES_KBPS.includes(numeric) ? numeric : DEFAULT_BITRATE_KBPS;
}

/**
 * Расширение для имени временного файла.
 *
 * Строгий белый список, а не «вырежем плохие символы»: значение приходит из
 * renderer и попадает в путь. Незнакомое расширение — не ошибка: ffmpeg
 * определяет контейнер по содержимому, а `.bin` его в этом не сбивает.
 */
export function normalizeSourceExt(value: unknown): string {
  const raw = String(value ?? '').toLowerCase().replace(/^\./, '');
  return /^(m4a|mp4|webm|opus|ogg|mp3|aac|flac|wav)$/.test(raw) ? raw : 'bin';
}

/** Запуск ffmpeg по умолчанию: без оболочки, с ограничением по времени. */
function defaultRunFfmpeg(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: TRANSCODE_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        // Последние строки stderr — единственное, что ffmpeg говорит по делу.
        const tail = String(stderr || '').trim().split('\n').slice(-3).join(' ');
        reject(new Error(tail ? `${err.message}: ${tail}` : err.message));
        return;
      }
      resolve();
    });
  });
}

export class AudioTranscoder {
  private readonly ffmpegPath: string;
  private readonly tempDir: string;
  private readonly logImpl: (message: string) => void;
  private readonly exists: typeof existsSync;
  private readonly run: (exe: string, args: string[]) => Promise<void>;
  private readonly uniqueSuffix: () => string;
  private counter = 0;

  constructor(deps: TranscoderDeps) {
    this.ffmpegPath = deps.ffmpegPath;
    this.tempDir = deps.tempDir;
    this.logImpl = deps.log || (() => {});
    this.exists = deps.existsImpl || existsSync;
    this.run = deps.runFfmpeg || defaultRunFfmpeg;
    this.uniqueSuffix = deps.uniqueSuffix || (() => `${Date.now()}-${++this.counter}`);
  }

  /** Есть ли чем сжимать. Renderer спрашивает заранее, чтобы не обещать лишнего. */
  public isAvailable(): boolean {
    return Boolean(this.ffmpegPath) && this.exists(this.ffmpegPath);
  }

  /**
   * Перекодирует аудио в opus.
   *
   * Никогда не бросает из-за самого перекодирования: не получилось — вернём
   * оригинал с причиной. Сохранить трек несжатым лучше, чем не сохранить.
   */
  public async transcode(request: TranscodeRequest): Promise<TranscodeResult> {
    const input = request?.data;
    const sourceExt = normalizeSourceExt(request?.sourceExt);
    const bitrate = normalizeBitrate(request?.bitrateKbps);

    if (!input || input.byteLength === 0) {
      return { data: input || new Uint8Array(0), format: sourceExt, bitrate, compressed: false, reason: 'пустые данные' };
    }
    if (input.byteLength > MAX_TRANSCODE_INPUT_BYTES) {
      this.logImpl(`ffmpeg: пропускаем ${input.byteLength} Б — больше предела`);
      return { data: input, format: sourceExt, bitrate, compressed: false, reason: 'файл слишком большой' };
    }
    if (!this.isAvailable()) {
      this.logImpl('ffmpeg: бинарник не найден, сохраняем как есть');
      return { data: input, format: sourceExt, bitrate, compressed: false, reason: 'ffmpeg недоступен' };
    }

    const suffix = this.uniqueSuffix();
    const workDir = path.join(this.tempDir, 'transcode');
    const inputPath = path.join(workDir, `in-${suffix}.${sourceExt}`);
    const outputPath = path.join(workDir, `out-${suffix}.opus`);

    try {
      mkdirSync(workDir, { recursive: true });
      writeFileSync(inputPath, input);

      await this.run(this.ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-i', inputPath,
        // Видеодорожку YouTube иногда всё же вкладывает: в аудиофайл ей нельзя.
        '-vn',
        '-map_metadata', '0',
        '-c:a', 'libopus',
        '-b:a', `${bitrate}k`,
        // `audio` вместо `voip`: это музыка, а не разговор.
        '-application', 'audio',
        // Стерео при любом входе: моно-микс сэкономил бы ещё, но это уже не
        // «то же самое, только меньше».
        '-ac', '2',
        '-f', 'ogg',
        outputPath
      ]);

      const output = readFileSync(outputPath);
      if (output.byteLength === 0) {
        throw new Error('ffmpeg вернул пустой файл');
      }
      // Битрейт выше исходного не уменьшает файл, а увеличивает: тогда сжатие
      // теряет весь смысл, и оригинал честнее.
      if (output.byteLength >= input.byteLength) {
        this.logImpl(`ffmpeg: ${bitrate}k не уменьшил файл (${input.byteLength} → ${output.byteLength}), берём оригинал`);
        return { data: input, format: sourceExt, bitrate, compressed: false, reason: 'сжатие не уменьшило файл' };
      }

      const saved = Math.round((1 - output.byteLength / input.byteLength) * 100);
      this.logImpl(`ffmpeg: ${input.byteLength} → ${output.byteLength} Б (opus ${bitrate}k, −${saved}%)`);
      return { data: new Uint8Array(output), format: 'opus', bitrate, compressed: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logImpl(`ffmpeg: не удалось сжать (${message}), сохраняем как есть`);
      return { data: input, format: sourceExt, bitrate, compressed: false, reason: message };
    } finally {
      // Временные файлы удаляются всегда: иначе первая же ошибка оставит на
      // диске мусор размером с трек, и так до конца жизни установки.
      for (const file of [inputPath, outputPath]) {
        try {
          rmSync(file, { force: true });
        } catch {
          // Файл держит антивирус — не повод рушить сохранение трека.
        }
      }
    }
  }
}
