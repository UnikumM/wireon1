/**
 * Профили эквалайзера в сторе плеера.
 *
 * Суть проверяемого: профиль сохраняется из текущих полос, применяется и
 * удаляется; при подключении привязанного устройства включается сам, с тостом;
 * мусор из базы не ломает загрузку настроек.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../setup';
import { usePlayerStore, PLAYER_SETTING_KEYS } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { audioEngine } from '../../src/services/audioEngine';
import * as dbService from '../../src/services/db';
import { resetPlayerStore, flushAsync } from '../helpers/testUtils';

const player = () => usePlayerStore.getState();

describe('Профили эквалайзера в сторе', () => {
  beforeEach(async () => {
    await dbService.setSetting(PLAYER_SETTING_KEYS.eq, { bass: 0, mid: 0, treble: 0 });
    await dbService.setSetting(PLAYER_SETTING_KEYS.eqProfiles, []);
    await dbService.setSetting(PLAYER_SETTING_KEYS.activeEqProfileId, null);
    resetPlayerStore();
    usePlayerStore.setState({
      eqProfiles: [],
      activeEqProfileId: null,
      eqOutputDevice: null,
      eqDeviceSupport: 'unknown',
      mobileAudioFx: false
    });
    useUIStore.setState({ toastMessage: null });
  });

  describe('сохранение и применение', () => {
    it('сохраняет текущие полосы профилем и делает его активным', async () => {
      player().setEq({ bass: 5, mid: -1, treble: 2 });

      const profile = player().saveEqProfile('  Наушники  ');

      expect(profile).not.toBeNull();
      expect(profile?.name).toBe('Наушники');
      expect(profile?.eq).toEqual({ bass: 5, mid: -1, treble: 2 });
      expect(profile?.deviceId).toBeNull();
      expect(player().activeEqProfileId).toBe(profile?.id);
      await flushAsync();
      expect(await dbService.getSetting(PLAYER_SETTING_KEYS.eqProfiles, null)).toEqual([profile]);
      expect(await dbService.getSetting(PLAYER_SETTING_KEYS.activeEqProfileId, null)).toBe(profile?.id);
    });

    it('пустое имя профилем не становится', () => {
      expect(player().saveEqProfile('   ')).toBeNull();
      expect(player().eqProfiles).toEqual([]);
    });

    it('применение ставит полосы профиля и передаёт их движку', () => {
      const spy = vi.spyOn(audioEngine, 'setEqGains');
      player().setEq({ bass: 5, mid: -1, treble: 2 });
      const profile = player().saveEqProfile('Наушники')!;
      player().setEq({ bass: 0, mid: 0, treble: 0 });
      expect(player().activeEqProfileId).toBeNull();

      player().applyEqProfile(profile.id);

      expect(player().eq).toEqual({ bass: 5, mid: -1, treble: 2 });
      expect(player().activeEqProfileId).toBe(profile.id);
      expect(spy).toHaveBeenLastCalledWith({ bass: 5, mid: -1, treble: 2 });
      spy.mockRestore();
    });

    it('полосы, сдвинутые рукой, снимают профиль с активного', () => {
      player().setEq({ bass: 5 });
      const profile = player().saveEqProfile('Наушники')!;

      player().setEq({ treble: 3 });

      expect(player().activeEqProfileId).toBeNull();
      // А те же значения обратно — профиль снова он.
      player().applyEqProfile(profile.id);
      player().setEq({ treble: 0 });
      expect(player().activeEqProfileId).toBe(profile.id);
    });

    it('переименование меняет имя и не трогает полосы', () => {
      const profile = player().saveEqProfile('Старое')!;
      player().renameEqProfile(profile.id, ' Новое имя ');
      expect(player().eqProfiles[0]).toMatchObject({ id: profile.id, name: 'Новое имя', eq: profile.eq });
      // Пустое имя и чужой id — ничего не делают.
      player().renameEqProfile(profile.id, '   ');
      player().renameEqProfile('нет такого', 'Имя');
      expect(player().eqProfiles[0].name).toBe('Новое имя');
    });

    it('удаление убирает профиль, снимает активность и не трогает звук', async () => {
      player().setEq({ bass: 5 });
      const profile = player().saveEqProfile('Наушники')!;

      player().deleteEqProfile(profile.id);

      expect(player().eqProfiles).toEqual([]);
      expect(player().activeEqProfileId).toBeNull();
      expect(player().eq).toEqual({ bass: 5, mid: 0, treble: 0 });
      await flushAsync();
      expect(await dbService.getSetting(PLAYER_SETTING_KEYS.eqProfiles, null)).toEqual([]);
    });
  });

  describe('привязка к устройству', () => {
    it('одно устройство держит один профиль', () => {
      const a = player().saveEqProfile('А')!;
      const b = player().saveEqProfile('Б')!;

      player().bindEqProfileToDevice(a.id, 'hp');
      player().bindEqProfileToDevice(b.id, 'hp');

      const byId = Object.fromEntries(player().eqProfiles.map((p) => [p.id, p.deviceId]));
      expect(byId[a.id]).toBeNull();
      expect(byId[b.id]).toBe('hp');

      player().bindEqProfileToDevice(b.id, null);
      expect(player().eqProfiles.find((p) => p.id === b.id)?.deviceId).toBeNull();
    });

    it('подключение привязанного устройства включает профиль с тостом', () => {
      player().setEq({ bass: 6, mid: 0, treble: 3 });
      const hp = player().saveEqProfile('Наушники')!;
      player().bindEqProfileToDevice(hp.id, 'hp');
      player().setEq({ bass: 0, mid: 0, treble: 0 });
      expect(player().activeEqProfileId).toBeNull();

      player().noteEqOutputDevice({ deviceId: 'hp', label: 'Наушники' }, 'available');

      expect(player().eq).toEqual({ bass: 6, mid: 0, treble: 3 });
      expect(player().activeEqProfileId).toBe(hp.id);
      expect(player().eqOutputDevice).toEqual({ deviceId: 'hp', label: 'Наушники' });
      expect(player().eqDeviceSupport).toBe('available');
      const toast = useUIStore.getState().toastMessage;
      expect(toast?.text).toBe('Включён профиль «Наушники»');
    });

    it('то же устройство ещё раз — профиль не переприменяется и тост не повторяется', () => {
      player().setEq({ bass: 6 });
      const hp = player().saveEqProfile('Наушники')!;
      player().bindEqProfileToDevice(hp.id, 'hp');
      player().noteEqOutputDevice({ deviceId: 'hp', label: '' }, 'available');
      useUIStore.setState({ toastMessage: null });

      player().noteEqOutputDevice({ deviceId: 'hp', label: '' }, 'available');

      expect(useUIStore.getState().toastMessage).toBeNull();
    });

    it('устройство без привязки оставляет полосы как есть', () => {
      player().setEq({ bass: 6 });
      const hp = player().saveEqProfile('Наушники')!;
      player().bindEqProfileToDevice(hp.id, 'hp');
      player().setEq({ bass: -2, mid: 0, treble: 0 });

      player().noteEqOutputDevice({ deviceId: 'usb', label: 'USB' }, 'available');

      expect(player().eq).toEqual({ bass: -2, mid: 0, treble: 0 });
      expect(player().activeEqProfileId).toBeNull();
      expect(useUIStore.getState().toastMessage).toBeNull();
    });

    it('без устройств запоминает, что привязка недоступна', () => {
      player().noteEqOutputDevice(null, 'unsupported');
      expect(player().eqOutputDevice).toBeNull();
      expect(player().eqDeviceSupport).toBe('unsupported');
    });
  });

  describe('загрузка из базы', () => {
    it('чистит мусор в профилях и держит активным только существующий и совпадающий', async () => {
      await dbService.setSetting(PLAYER_SETTING_KEYS.eq, { bass: 4, mid: 0, treble: 0 });
      await dbService.setSetting(PLAYER_SETTING_KEYS.eqProfiles, [
        { id: 'ok', name: 'Наушники', eq: { bass: 4, mid: 0, treble: 0 }, deviceId: 'hp' },
        { id: 'loud', name: 'Громко', eq: { bass: 99, mid: 'x', treble: -40 } },
        { id: '', name: 'Без id' },
        { name: 'Без id вовсе', eq: {} },
        null,
        'мусор'
      ]);
      await dbService.setSetting(PLAYER_SETTING_KEYS.activeEqProfileId, 'ok');

      await player().hydrateSettings();

      expect(player().eqProfiles).toEqual([
        { id: 'ok', name: 'Наушники', eq: { bass: 4, mid: 0, treble: 0 }, deviceId: 'hp' },
        { id: 'loud', name: 'Громко', eq: { bass: 12, mid: 0, treble: -12 }, deviceId: null }
      ]);
      expect(player().activeEqProfileId).toBe('ok');
    });

    it('активный профиль, которого нет или чьи полосы не стоят, забывается', async () => {
      await dbService.setSetting(PLAYER_SETTING_KEYS.eq, { bass: 0, mid: 0, treble: 0 });
      await dbService.setSetting(PLAYER_SETTING_KEYS.eqProfiles, [
        { id: 'ok', name: 'Наушники', eq: { bass: 4, mid: 0, treble: 0 } }
      ]);
      await dbService.setSetting(PLAYER_SETTING_KEYS.activeEqProfileId, 'ok');

      await player().hydrateSettings();
      expect(player().activeEqProfileId).toBeNull();

      usePlayerStore.setState({ settingsHydrated: false });
      await dbService.setSetting(PLAYER_SETTING_KEYS.activeEqProfileId, 'призрак');
      await player().hydrateSettings();
      expect(player().activeEqProfileId).toBeNull();
    });

    it('не массив вместо профилей — пустой список, настройки загружаются', async () => {
      await dbService.setSetting(PLAYER_SETTING_KEYS.eqProfiles, { id: 'x' });
      await player().hydrateSettings();
      expect(player().eqProfiles).toEqual([]);
      expect(player().settingsHydrated).toBe(true);
    });
  });
});
