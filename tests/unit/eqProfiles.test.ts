/**
 * Профили эквалайзера: выбор профиля по устройству вывода.
 *
 * Суть проверяемого: привязанный профиль включается с тем устройством, к
 * которому привязан, а где устройств не видно — ничего не выбирается и
 * интерфейс узнаёт об этом честно.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EqProfile,
  pickDefaultOutput,
  pickProfileForDevices,
  sanitizeEqProfiles,
  cleanEqProfileName,
  subscribeOutputDevice,
  readOutputDevice,
  EQ_PROFILE_NAME_LIMIT
} from '../../src/services/eqProfiles';
import { EqSettings } from '../../src/types/music';

function device(kind: MediaDeviceKind, deviceId: string, groupId = '', label = ''): MediaDeviceInfo {
  return { kind, deviceId, groupId, label, toJSON: () => ({}) } as MediaDeviceInfo;
}

const headphones: EqProfile = { id: 'p1', name: 'Наушники', eq: { bass: 4, mid: 0, treble: 2 }, deviceId: 'hp' };
const speakers: EqProfile = { id: 'p2', name: 'Колонки', eq: { bass: -2, mid: 1, treble: 0 }, deviceId: 'spk' };
const loose: EqProfile = { id: 'p3', name: 'Без привязки', eq: { bass: 1, mid: 1, treble: 1 }, deviceId: null };

const identityEq = (value: unknown, fallback: EqSettings): EqSettings => {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<EqSettings>;
  return {
    bass: typeof v.bass === 'number' ? v.bass : fallback.bass,
    mid: typeof v.mid === 'number' ? v.mid : fallback.mid,
    treble: typeof v.treble === 'number' ? v.treble : fallback.treble
  };
};

describe('Профили эквалайзера: устройство вывода', () => {
  describe('устройство по умолчанию', () => {
    it('берёт настоящую запись той же группы, а не ярлык default', () => {
      const devices = [
        device('audioinput', 'mic', 'g-mic', 'Микрофон'),
        device('audiooutput', 'default', 'g-hp', 'Default — Наушники'),
        device('audiooutput', 'spk', 'g-spk', 'Колонки'),
        device('audiooutput', 'hp', 'g-hp', 'Наушники')
      ];
      expect(pickDefaultOutput(devices)).toEqual({ deviceId: 'hp', label: 'Наушники' });
    });

    it('без ярлыка default берёт первое устройство вывода', () => {
      const devices = [device('audioinput', 'mic'), device('audiooutput', 'spk', 'g1', 'Колонки')];
      expect(pickDefaultOutput(devices)?.deviceId).toBe('spk');
    });

    it('без разрешения Chrome отдаёт пустые deviceId — такие не годятся', () => {
      // Запись с пустым id — это не устройство, к которому можно привязаться.
      expect(pickDefaultOutput([device('audiooutput', '', '', '')])).toBeNull();
    });

    it('когда выводов нет вовсе (Android WebView), устройство неизвестно', () => {
      expect(pickDefaultOutput([device('audioinput', 'mic'), device('videoinput', 'cam')])).toBeNull();
    });
  });

  describe('выбор профиля', () => {
    const profiles = [headphones, speakers, loose];

    it('находит профиль, привязанный к текущему устройству', () => {
      const devices = [device('audiooutput', 'default', 'g-hp'), device('audiooutput', 'hp', 'g-hp', 'Наушники')];
      expect(pickProfileForDevices(profiles, devices)?.id).toBe('p1');
    });

    it('переключение на колонки даёт их профиль', () => {
      expect(pickProfileForDevices(profiles, [device('audiooutput', 'spk', 'g-spk')])?.id).toBe('p2');
    });

    it('устройство без привязки — ничего не меняем', () => {
      // Эквалайзер остаётся как был: человек мог настроить его руками только что.
      expect(pickProfileForDevices(profiles, [device('audiooutput', 'usb', 'g-usb')])).toBeNull();
    });

    it('без устройств профиль не выбирается', () => {
      expect(pickProfileForDevices(profiles, [])).toBeNull();
      expect(pickProfileForDevices(profiles, [device('audioinput', 'mic')])).toBeNull();
    });
  });

  describe('чистка записей из базы', () => {
    it('выбрасывает мусор и оставляет пригодные профили', () => {
      const raw = [
        headphones,
        null,
        'строка',
        { id: 'nope' }, // без имени
        { id: '', name: 'Пустой id' },
        { id: 'p1', name: 'Дубль id', eq: { bass: 1, mid: 1, treble: 1 } },
        { id: 'p9', name: '  Много   пробелов  ', eq: { bass: 'x', mid: 3 }, deviceId: 42 }
      ];
      const result = sanitizeEqProfiles(raw, identityEq);
      expect(result.map((p) => p.id)).toEqual(['p1', 'p9']);
      expect(result[1]).toEqual({ id: 'p9', name: 'Много пробелов', eq: { bass: 0, mid: 3, treble: 0 }, deviceId: null });
    });

    it('не массив — пустой список', () => {
      expect(sanitizeEqProfiles({ id: 'p1' }, identityEq)).toEqual([]);
      expect(sanitizeEqProfiles(undefined, identityEq)).toEqual([]);
    });

    it('имя обрезается до предела и не бывает пустым', () => {
      expect(cleanEqProfileName('   ')).toBeNull();
      expect(cleanEqProfileName(7)).toBeNull();
      expect(cleanEqProfileName('а'.repeat(100))?.length).toBe(EQ_PROFILE_NAME_LIMIT);
    });
  });

  describe('подписка на устройства', () => {
    const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

    afterEach(() => {
      if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
      else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    });

    function installMediaDevices(list: MediaDeviceInfo[]) {
      const listeners = new Set<() => void>();
      const md = {
        enumerateDevices: vi.fn(async () => list),
        addEventListener: vi.fn((_: string, cb: () => void) => listeners.add(cb)),
        removeEventListener: vi.fn((_: string, cb: () => void) => listeners.delete(cb))
      };
      Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true, writable: true });
      return {
        md,
        setList(next: MediaDeviceInfo[]) {
          list = next;
        },
        fire() {
          for (const cb of listeners) cb();
        },
        listeners
      };
    }

    it('без navigator.mediaDevices сразу сообщает, что привязка недоступна', async () => {
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
      const listener = vi.fn();
      const stop = subscribeOutputDevice(listener);
      expect(listener).toHaveBeenCalledWith(null, 'unsupported');
      expect(await readOutputDevice()).toEqual({ device: null, support: 'unsupported' });
      stop();
    });

    it('сообщает о текущем устройстве и о каждой его смене, но не о повторах', async () => {
      const fake = installMediaDevices([device('audiooutput', 'spk', 'g-spk', 'Колонки')]);
      const listener = vi.fn();
      const stop = subscribeOutputDevice(listener);
      await Promise.resolve();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith({ deviceId: 'spk', label: 'Колонки' }, 'available');

      // Тот же список ещё раз — молчим.
      fake.fire();
      await Promise.resolve();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);

      // Воткнули наушники: ярлык default переехал на них.
      fake.setList([
        device('audiooutput', 'default', 'g-hp', 'Default — Наушники'),
        device('audiooutput', 'spk', 'g-spk', 'Колонки'),
        device('audiooutput', 'hp', 'g-hp', 'Наушники')
      ]);
      fake.fire();
      await Promise.resolve();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith({ deviceId: 'hp', label: 'Наушники' }, 'available');

      stop();
      expect(fake.listeners.size).toBe(0);
      // После отписки события никуда не приходят.
      fake.setList([device('audiooutput', 'spk', 'g-spk')]);
      fake.fire();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('API есть, а выводов не видно — состояние hidden без устройства', async () => {
      installMediaDevices([device('audioinput', 'mic'), device('audiooutput', '', '', '')]);
      const listener = vi.fn();
      const stop = subscribeOutputDevice(listener);
      await Promise.resolve();
      await Promise.resolve();
      expect(listener).toHaveBeenCalledWith(null, 'hidden');
      stop();
    });
  });
});
