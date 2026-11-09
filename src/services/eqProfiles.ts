/**
 * Профили эквалайзера «мои наушники».
 *
 * Пресеты — общие кривые на все случаи, а профиль — настройка под конкретные
 * наушники или колонки: сохранённые полосы с именем и, по желанию, с привязкой
 * к устройству вывода. Привязанный профиль включается сам, когда это
 * устройство становится устройством по умолчанию: воткнул наушники — заиграло
 * так, как для них настроено.
 *
 * Здесь только чистая логика (выбор профиля по списку устройств, чистка того,
 * что пришло из базы) и подписка на устройства. Состояние и применение — в
 * `usePlayerStore`; модуль о сторе не знает, чтобы не замыкать импорт по кругу.
 *
 * Где привязка не работает
 * ------------------------
 * `enumerateDevices()` отдаёт устройства вывода не везде. Chrome и Electron —
 * да, причём с устойчивым `deviceId` на этот источник. Android WebView и
 * Firefox не отдают `audiooutput` вовсе, а Chrome без разрешения на микрофон
 * отдаёт по одной записи на вид с пустым `deviceId`. В этих случаях привязывать
 * не к чему, и интерфейс говорит об этом одной строкой.
 */

import { EqSettings } from '../types/music';

export interface EqProfile {
  id: string;
  name: string;
  eq: EqSettings;
  /** Устройство вывода, при котором профиль включается сам; `null` — без привязки. */
  deviceId?: string | null;
}

export interface OutputDevice {
  deviceId: string;
  /** Пустая строка, когда браузер имени не показывает. */
  label: string;
}

/**
 * Что система знает об устройствах вывода.
 *
 * - `unknown` — ещё не спрашивали;
 * - `available` — устройства видны, привязка возможна;
 * - `hidden` — API есть, но устройств вывода не отдаёт (Android WebView,
 *   Firefox, Chrome без разрешения);
 * - `unsupported` — `navigator.mediaDevices` нет вовсе.
 */
export type EqDeviceSupport = 'unknown' | 'available' | 'hidden' | 'unsupported';

export const EQ_PROFILE_NAME_LIMIT = 40;

const FLAT_EQ: EqSettings = { bass: 0, mid: 0, treble: 0 };

/** Полосы совпадают — и значит, профиль честно описывает то, что играет. */
export function sameEq(a: EqSettings, b: EqSettings): boolean {
  return a.bass === b.bass && a.mid === b.mid && a.treble === b.treble;
}

/** Имя профиля без лишних пробелов и не длиннее предела; пустое — `null`. */
export function cleanEqProfileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ').slice(0, EQ_PROFILE_NAME_LIMIT);
  return trimmed.length > 0 ? trimmed : null;
}

export function newEqProfileId(): string {
  return `eqp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Список профилей из базы, пригодный к работе.
 *
 * База переживает версии приложения, и в ней может лежать что угодно: не массив,
 * записи без имени, полосы строками, два профиля с одним `id`. Всё это
 * вычищается здесь, чтобы ни одна такая запись не уронила настройки.
 * Полосы приводит переданная функция — та же, что чистит обычный эквалайзер.
 */
export function sanitizeEqProfiles(
  raw: unknown,
  normalizeEq: (value: unknown, fallback: EqSettings) => EqSettings
): EqProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: EqProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<EqProfile>;
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || seen.has(candidate.id)) continue;
    const name = cleanEqProfileName(candidate.name);
    if (!name) continue;
    seen.add(candidate.id);
    result.push({
      id: candidate.id,
      name,
      eq: normalizeEq(candidate.eq, FLAT_EQ),
      deviceId: typeof candidate.deviceId === 'string' && candidate.deviceId ? candidate.deviceId : null
    });
  }
  return result;
}

/**
 * Устройство вывода по умолчанию из списка `enumerateDevices()`.
 *
 * Chromium отдаёт служебную запись `deviceId: 'default'` («Default — Наушники»)
 * и рядом — саму железку с тем же `groupId`. Привязываться к `'default'` нельзя:
 * это ярлык, который указывает на разные устройства в разное время. Поэтому
 * берём настоящую запись той же группы; если её нет — первую настоящую.
 * Записи с пустым `deviceId` (нет разрешения) не годятся вовсе.
 */
export function pickDefaultOutput(devices: readonly MediaDeviceInfo[]): OutputDevice | null {
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && typeof d.deviceId === 'string' && d.deviceId);
  if (outputs.length === 0) return null;
  const alias = outputs.find((d) => d.deviceId === 'default' || d.deviceId === 'communications');
  const real = outputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
  let chosen: MediaDeviceInfo | undefined;
  if (alias && alias.groupId) chosen = real.find((d) => d.groupId === alias.groupId);
  if (!chosen) chosen = real[0] ?? alias;
  if (!chosen) return null;
  return { deviceId: chosen.deviceId, label: typeof chosen.label === 'string' ? chosen.label : '' };
}

/** Профиль, привязанный к устройству, или `null`, когда такого нет. */
export function profileForDevice(profiles: readonly EqProfile[], deviceId: string | null): EqProfile | null {
  if (!deviceId) return null;
  return profiles.find((p) => p.deviceId === deviceId) ?? null;
}

/**
 * Какой профиль включать при таком списке устройств.
 *
 * `null`, когда устройств не видно или к текущему ничего не привязано: тогда
 * эквалайзер остаётся как был — человек мог настроить его руками только что.
 */
export function pickProfileForDevices(
  profiles: readonly EqProfile[],
  devices: readonly MediaDeviceInfo[]
): EqProfile | null {
  const current = pickDefaultOutput(devices);
  return profileForDevice(profiles, current?.deviceId ?? null);
}

function mediaDevices(): MediaDevices | null {
  if (typeof navigator === 'undefined') return null;
  const md = navigator.mediaDevices;
  if (!md || typeof md.enumerateDevices !== 'function') return null;
  return md;
}

/** Можно ли здесь вообще спросить об устройствах вывода. */
export function canEnumerateOutputs(): boolean {
  return mediaDevices() !== null;
}

/** Текущее устройство вывода и что о нём известно. */
export async function readOutputDevice(): Promise<{ device: OutputDevice | null; support: EqDeviceSupport }> {
  const md = mediaDevices();
  if (!md) return { device: null, support: 'unsupported' };
  try {
    const devices = await md.enumerateDevices();
    const device = pickDefaultOutput(devices);
    return { device, support: device ? 'available' : 'hidden' };
  } catch (err) {
    console.warn('[eqProfiles] enumerateDevices failed:', err);
    return { device: null, support: 'hidden' };
  }
}

export type OutputDeviceListener = (device: OutputDevice | null, support: EqDeviceSupport) => void;

/**
 * Подписка на смену устройства вывода.
 *
 * Сразу читает текущее устройство и дальше перечитывает по `devicechange`.
 * Слушателю сообщается каждый раз, когда `deviceId` меняется, и первый раз —
 * всегда, даже если устройств нет: интерфейсу нужно знать, что показывать.
 */
export function subscribeOutputDevice(listener: OutputDeviceListener): () => void {
  const md = mediaDevices();
  if (!md) {
    listener(null, 'unsupported');
    return () => {};
  }

  let disposed = false;
  let lastId: string | null | undefined;
  let lastSupport: EqDeviceSupport = 'unknown';

  const refresh = async (): Promise<void> => {
    const { device, support } = await readOutputDevice();
    if (disposed) return;
    const id = device?.deviceId ?? null;
    if (lastId === id && lastSupport === support) return;
    lastId = id;
    lastSupport = support;
    listener(device, support);
  };

  const onChange = (): void => {
    void refresh();
  };

  if (typeof md.addEventListener === 'function') md.addEventListener('devicechange', onChange);
  void refresh();

  return () => {
    disposed = true;
    if (typeof md.removeEventListener === 'function') md.removeEventListener('devicechange', onChange);
  };
}
