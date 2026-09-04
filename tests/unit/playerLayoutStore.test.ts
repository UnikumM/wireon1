import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  usePlayerLayoutStore,
  ARTWORK_RADIUS,
  DENSITY_METRICS,
  FULLSCREEN_ARTWORK_RADIUS,
  FULLSCREEN_MODULE_KEYS,
  PLAYER_BAR_MODULE_KEYS,
  PLAYER_LAYOUT_SETTING_KEYS,
  PROGRESS_STYLE_VARS
} from '../../src/store/usePlayerLayoutStore';
import * as dbService from '../../src/services/db';
import { flushAsync } from '../helpers/testUtils';

/**
 * Разметка плеера. Проверяется три вещи: значения по умолчанию совпадают с
 * текущим видом полосы, каждый сеттер доходит до базы, и мусор из базы не
 * доезжает до интерфейса.
 */
describe('usePlayerLayoutStore', () => {
  beforeEach(async () => {
    usePlayerLayoutStore.getState().resetLayout();
    usePlayerLayoutStore.setState({ layoutHydrated: false });
    await dbService.clearAllData();
    await flushAsync();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('defaults', () => {
    it('opens on exactly the layout the player already had', () => {
      const state = usePlayerLayoutStore.getState();

      expect(state.density).toBe('comfortable');
      expect(state.artworkShape).toBe('rounded');
      expect(state.artworkClickAction).toBe('fullscreen');
      expect(state.progressStyle).toBe('thin');
      // Ничего не спрятано: настройка появляется, поведение — нет.
      expect(Object.values(state.modules).every(Boolean)).toBe(true);
      expect(Object.values(state.fullscreenModules).every(Boolean)).toBe(true);
    });

    it('keeps every declared module key in both maps', () => {
      const state = usePlayerLayoutStore.getState();
      expect(Object.keys(state.modules).sort()).toEqual([...PLAYER_BAR_MODULE_KEYS].sort());
      expect(Object.keys(state.fullscreenModules).sort()).toEqual([...FULLSCREEN_MODULE_KEYS].sort());
    });

    it('maps the default enum values onto the metrics the bar uses today', () => {
      expect(DENSITY_METRICS.comfortable).toMatchObject({
        barGap: 'var(--space-4)',
        barPadding: '0 var(--space-5)',
        artworkSize: '52px'
      });
      expect(ARTWORK_RADIUS.rounded).toBe('var(--radius-sm)');
      expect(FULLSCREEN_ARTWORK_RADIUS.rounded).toBe('var(--radius-lg)');
      // «Тонкая» ничего не переопределяет — толщину задаёт тема.
      expect(PROGRESS_STYLE_VARS.thin).toEqual({});
      expect(PROGRESS_STYLE_VARS.thick['--range-track-height']).toBe('10px');
    });
  });

  describe('setters', () => {
    it('stores every enum choice and writes it through the db service', async () => {
      const store = usePlayerLayoutStore.getState();
      store.setDensity('spacious');
      store.setArtworkShape('circle');
      store.setArtworkClickAction('visualizer');
      store.setProgressStyle('thick');
      await flushAsync();

      const state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('spacious');
      expect(state.artworkShape).toBe('circle');
      expect(state.artworkClickAction).toBe('visualizer');
      expect(state.progressStyle).toBe('thick');

      expect(await dbService.getSetting<string>(PLAYER_LAYOUT_SETTING_KEYS.density, 'x')).toBe('spacious');
      expect(await dbService.getSetting<string>(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, 'x')).toBe('circle');
      expect(await dbService.getSetting<string>(PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction, 'x')).toBe(
        'visualizer'
      );
      expect(await dbService.getSetting<string>(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, 'x')).toBe('thick');
    });

    it('toggles a single bar module without touching its neighbours', async () => {
      usePlayerLayoutStore.getState().toggleModule('volume');
      await flushAsync();

      const { modules } = usePlayerLayoutStore.getState();
      expect(modules.volume).toBe(false);
      expect(modules.queue).toBe(true);

      const persisted = await dbService.getSetting<Record<string, boolean>>(
        PLAYER_LAYOUT_SETTING_KEYS.modules,
        {}
      );
      expect(persisted.volume).toBe(false);
      expect(persisted.queue).toBe(true);

      usePlayerLayoutStore.getState().toggleModule('volume');
      expect(usePlayerLayoutStore.getState().modules.volume).toBe(true);
    });

    it('toggles a fullscreen module and persists the whole map', async () => {
      usePlayerLayoutStore.getState().toggleFullscreenModule('visualizer');
      await flushAsync();

      expect(usePlayerLayoutStore.getState().fullscreenModules.visualizer).toBe(false);
      const persisted = await dbService.getSetting<Record<string, boolean>>(
        PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules,
        {}
      );
      expect(persisted).toMatchObject({ visualizer: false, artwork: true, lyrics: true, queue: true });
    });

    it('never lets a failing write reach the caller', async () => {
      vi.spyOn(dbService, 'setSetting').mockRejectedValue(new Error('IndexedDB blocked'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(() => usePlayerLayoutStore.getState().setDensity('compact')).not.toThrow();
      await flushAsync();

      // Состояние применилось, несмотря на мёртвую базу.
      expect(usePlayerLayoutStore.getState().density).toBe('compact');
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('resetLayout', () => {
    it('brings back every default and writes them all out', async () => {
      const store = usePlayerLayoutStore.getState();
      store.setDensity('compact');
      store.setArtworkShape('square');
      store.setArtworkClickAction('none');
      store.setProgressStyle('thick');
      store.toggleModule('lyrics');
      store.toggleFullscreenModule('queue');
      await flushAsync();

      usePlayerLayoutStore.getState().resetLayout();
      await flushAsync();

      const state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('comfortable');
      expect(state.artworkShape).toBe('rounded');
      expect(state.artworkClickAction).toBe('fullscreen');
      expect(state.progressStyle).toBe('thin');
      expect(state.modules.lyrics).toBe(true);
      expect(state.fullscreenModules.queue).toBe(true);

      expect(await dbService.getSetting<string>(PLAYER_LAYOUT_SETTING_KEYS.density, 'x')).toBe('comfortable');
      const persistedModules = await dbService.getSetting<Record<string, boolean>>(
        PLAYER_LAYOUT_SETTING_KEYS.modules,
        {}
      );
      expect(Object.values(persistedModules).every(Boolean)).toBe(true);
    });

    it('hands out a fresh module map, so a later toggle cannot poison the defaults', () => {
      usePlayerLayoutStore.getState().resetLayout();
      const first = usePlayerLayoutStore.getState().modules;
      usePlayerLayoutStore.getState().toggleModule('tempo');
      usePlayerLayoutStore.getState().resetLayout();

      expect(usePlayerLayoutStore.getState().modules).not.toBe(first);
      expect(usePlayerLayoutStore.getState().modules.tempo).toBe(true);
    });
  });

  describe('hydratePlayerLayout', () => {
    it('restores what was saved, exactly once', async () => {
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.density, 'compact');
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, 'circle');
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction, 'none');
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, 'thick');
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.modules, { queue: false });
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules, { artwork: false });

      await usePlayerLayoutStore.getState().hydratePlayerLayout();

      let state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('compact');
      expect(state.artworkShape).toBe('circle');
      expect(state.artworkClickAction).toBe('none');
      expect(state.progressStyle).toBe('thick');
      expect(state.modules.queue).toBe(false);
      // Ключей, которых в записи не было, гидратация не трогает.
      expect(state.modules.volume).toBe(true);
      expect(state.fullscreenModules.artwork).toBe(false);
      expect(state.layoutHydrated).toBe(true);

      // Повторный вызов не перечитывает базу: живое состояние старше записи.
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.density, 'spacious');
      await usePlayerLayoutStore.getState().hydratePlayerLayout();
      state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('compact');
    });

    it('falls back to defaults for values it does not recognise', async () => {
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.density, 'enormous');
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, 42);
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction, null);
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, { thin: true });
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.modules, ['queue', 'volume']);
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules, {
        artwork: 'да',
        lyrics: false,
        somethingElse: true
      });

      await usePlayerLayoutStore.getState().hydratePlayerLayout();

      const state = usePlayerLayoutStore.getState();
      expect(state.density).toBe('comfortable');
      expect(state.artworkShape).toBe('rounded');
      expect(state.artworkClickAction).toBe('fullscreen');
      expect(state.progressStyle).toBe('thin');
      // Массив — не карта переключателей, поэтому берутся значения по умолчанию.
      expect(Object.values(state.modules).every(Boolean)).toBe(true);
      // А внутри настоящей карты чинится только испорченный ключ.
      expect(state.fullscreenModules.artwork).toBe(true);
      expect(state.fullscreenModules.lyrics).toBe(false);
      expect(Object.keys(state.fullscreenModules)).not.toContain('somethingElse');
    });

    it('survives an unavailable settings table', async () => {
      vi.spyOn(dbService, 'getSetting').mockRejectedValue(new Error('IndexedDB blocked'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await expect(usePlayerLayoutStore.getState().hydratePlayerLayout()).resolves.toBeUndefined();

      expect(usePlayerLayoutStore.getState().layoutHydrated).toBe(true);
      expect(usePlayerLayoutStore.getState().density).toBe('comfortable');
      expect(warn).toHaveBeenCalled();
    });

    it('reads the database once when two callers race', async () => {
      const spy = vi.spyOn(dbService, 'getSetting');
      await Promise.all([
        usePlayerLayoutStore.getState().hydratePlayerLayout(),
        usePlayerLayoutStore.getState().hydratePlayerLayout()
      ]);

      // Шесть ключей, а не двенадцать: второй вызов присоединяется к первому.
      expect(spy).toHaveBeenCalledTimes(Object.keys(PLAYER_LAYOUT_SETTING_KEYS).length);
    });

    it('keeps the module maps by reference when nothing was saved', async () => {
      const before = usePlayerLayoutStore.getState();

      await usePlayerLayoutStore.getState().hydratePlayerLayout();

      const after = usePlayerLayoutStore.getState();
      // Та же ссылка — иначе подписанный на `modules` плеер перерисовывался бы
      // сразу после запуска, ничего при этом не меняя.
      expect(after.modules).toBe(before.modules);
      expect(after.fullscreenModules).toBe(before.fullscreenModules);
    });
  });
});
