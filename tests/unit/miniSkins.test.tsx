import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '../setup';

import { MiniWindow } from '../../src/components/player/mini/MiniWindow';
import { PlayerLayoutSettings } from '../../src/components/settings/PlayerLayoutSettings';
import { usePlayerLayoutStore, PLAYER_LAYOUT_SETTING_KEYS } from '../../src/store/usePlayerLayoutStore';
import {
  MINI_SKINS,
  MINI_SKIN_IDS,
  MINI_SKIN_LIST,
  MINI_SKIN_VAR_NAMES,
  DEFAULT_MINI_SKIN_ID,
  isMiniSkinId,
  miniSkinVars,
  MiniSkinId
} from '../../src/styles/miniSkins';
import type { MiniPlayerState } from '../../src/types/electron';
import * as dbService from '../../src/services/db';

/**
 * Облики мини-плеера.
 *
 * Просьба была «сделать бы еще пресеты мини плейера этого крутыек а то он очень
 * недоработанный», и главная опасность здесь не в некрасивом облике, а в
 * молчаливом: инлайновый стиль в этом проекте сильнее таблицы стилей, поэтому
 * переменная, которую окно перестало читать, не ломает ничего заметного — облик
 * просто тихо перестаёт отличаться от «Панели». Отсюда проверка не картинок, а
 * связи: объявлено — прочитано — доехало.
 */

const SRC = path.resolve(__dirname, '../../src');
const MINI_WINDOW_TSX = readFileSync(path.join(SRC, 'components/player/mini/MiniWindow.tsx'), 'utf8');
const MINI_CSS = readFileSync(path.join(SRC, 'styles/mini.css'), 'utf8');
const GLOBAL_CSS = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');

function snapshot(overrides: Partial<MiniPlayerState> = {}): MiniPlayerState {
  return {
    title: 'Ночная смена',
    artist: 'Гидропоника',
    artwork: null,
    isPlaying: false,
    currentTime: 12,
    duration: 200,
    volume: 0.8,
    isFavorite: false,
    shuffle: false,
    repeat: 'off',
    accent: null,
    ...overrides
  };
}

/** Только та половина провода, что нужна окну: доставка снимков в него. */
function installStatePipe() {
  const listeners = new Set<(state: MiniPlayerState) => void>();
  const api = {
    isMiniWindow: true,
    closeMiniWindow: vi.fn().mockResolvedValue(true),
    sendMiniCommand: vi.fn(),
    onMiniState: (callback: (state: MiniPlayerState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };

  const previous = (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;

  return {
    push: (state: MiniPlayerState) => act(() => listeners.forEach((listener) => listener(state))),
    restore: () => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = previous;
    }
  };
}

/** Тело правила `selector { ... }` из таблицы стилей. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`нет правила ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('Облики мини-плеера', () => {
  describe('Набор обликов', () => {
    it('каждый облик задаёт все переменные и ни одной лишней', () => {
      for (const id of MINI_SKIN_IDS) {
        const keys = Object.keys(MINI_SKINS[id].vars).sort();
        expect(keys, `облик ${id}`).toEqual([...MINI_SKIN_VAR_NAMES].sort());
      }
    });

    it('у каждого облика есть человеческое имя и подсказка', () => {
      for (const skin of MINI_SKIN_LIST) {
        expect(skin.name.length, `имя ${skin.id}`).toBeGreaterThan(2);
        expect(skin.hint.length, `подсказка ${skin.id}`).toBeGreaterThan(10);
      }
      // Список — те же облики и в том же порядке, что и объявленные идентификаторы.
      expect(MINI_SKIN_LIST.map((skin) => skin.id)).toEqual([...MINI_SKIN_IDS]);
    });

    it('испорченный облик не оставляет окно без фона, а откатывает к «Панели»', () => {
      expect(miniSkinVars('облик-из-старой-базы' as MiniSkinId)).toEqual(
        MINI_SKINS[DEFAULT_MINI_SKIN_ID].vars
      );
      expect(isMiniSkinId('vinyl')).toBe(true);
      expect(isMiniSkinId('облик-из-старой-базы')).toBe(false);
      expect(isMiniSkinId(undefined)).toBe(false);
    });

    it('окно читает каждую объявленную переменную', () => {
      // Смысл проверки: переменная, которую окно не читает, — не облик, а
      // мёртвая строка. Отличить её на глаз нельзя, вид получается прежний.
      for (const name of MINI_SKIN_VAR_NAMES) {
        expect(MINI_WINDOW_TSX, `переменная ${name}`).toContain(`var(${name})`);
      }
    });

    it('значения по умолчанию в таблице стилей совпадают с «Панелью»', () => {
      const root = ruleBody(MINI_CSS, ':root');
      for (const [name, value] of Object.entries(MINI_SKINS[DEFAULT_MINI_SKIN_ID].vars)) {
        expect(root, `значение ${name}`).toContain(`${name}: ${value};`);
      }
    });

    it('таблица обликов подключена к сборке стилей', () => {
      expect(GLOBAL_CSS).toContain("@import './mini.css';");
    });
  });

  describe('Характер обликов в таблице стилей', () => {
    it('«Винил» вращается только вместе со звуком', () => {
      expect(MINI_CSS).toContain("[data-mini-skin='vinyl'] .mini-artwork");
      expect(ruleBody(MINI_CSS, "[data-mini-skin='vinyl'] .mini-artwork")).toContain(
        'animation-play-state: paused'
      );
      expect(
        ruleBody(MINI_CSS, "[data-mini-skin='vinyl'][data-playing='true'] .mini-artwork")
      ).toContain('animation-play-state: running');
    });

    it('«Индикатор» приглушает кнопки и возвращает их при наведении', () => {
      expect(ruleBody(MINI_CSS, "[data-mini-skin='hud'] .mini-controls")).toContain('opacity: 0.45');
      expect(MINI_CSS).toContain("[data-mini-skin='hud']:hover .mini-controls");
      expect(MINI_CSS).toContain("[data-mini-skin='hud']:focus-within .mini-controls");
    });

    it('сокращённое движение снимает вращение и переходы', () => {
      const reduced = MINI_CSS.slice(MINI_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
      expect(reduced.length, 'нет блока сокращённого движения').toBeGreaterThan(0);
      expect(reduced).toContain('animation: none');
      expect(reduced).toContain('transition: none');
    });

    it('переход между обликами не двигает размеры — окно всего 132px', () => {
      const shared = ruleBody(MINI_CSS, '[data-mini-skin]');
      expect(shared).toContain('background-color');
      expect(shared).not.toContain('transition: all');
      expect(shared).not.toContain('width');
      expect(shared).not.toContain('height');
    });
  });

  describe('Хранение выбора', () => {
    beforeEach(async () => {
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
      await dbService.clearAllData();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('по умолчанию — «Панель», то есть сегодняшний вид', () => {
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe('panel');
      expect(DEFAULT_MINI_SKIN_ID).toBe('panel');
    });

    it('выбор переживает перезапуск', async () => {
      act(() => usePlayerLayoutStore.getState().setMiniSkin('vinyl'));
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe('vinyl');

      // Запись идёт мимо интерфейса, поэтому ждём её отдельно.
      await act(async () => {
        await Promise.resolve();
      });
      expect(await dbService.getSetting(PLAYER_LAYOUT_SETTING_KEYS.miniSkinId, 'panel')).toBe('vinyl');

      // Запуск с нуля: значение по умолчанию плюс непрочитанная база.
      act(() => {
        usePlayerLayoutStore.setState({ miniSkinId: 'panel', layoutHydrated: false });
      });
      await usePlayerLayoutStore.getState().hydratePlayerLayout();
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe('vinyl');
    });

    it('чужое значение в базе не доходит до окна', async () => {
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.miniSkinId, 'обои-рабочего-стола');
      act(() => {
        usePlayerLayoutStore.setState({ miniSkinId: 'neon', layoutHydrated: false });
      });
      await usePlayerLayoutStore.getState().hydratePlayerLayout();
      // Остаётся то, что было: испорченная настройка — причина ничего не менять.
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe('neon');
    });

    it('сброс разметки возвращает и облик мини-плеера', () => {
      act(() => usePlayerLayoutStore.getState().setMiniSkin('poster'));
      act(() => usePlayerLayoutStore.getState().resetLayout());
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe(DEFAULT_MINI_SKIN_ID);
    });
  });

  describe('Окно', () => {
    let pipe: ReturnType<typeof installStatePipe>;

    beforeEach(() => {
      pipe = installStatePipe();
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
    });

    afterEach(() => {
      cleanup();
      pipe.restore();
      vi.restoreAllMocks();
    });

    it('до первого снимка рисует облик из своей настройки — без вспышки чужого вида', () => {
      act(() => {
        usePlayerLayoutStore.setState({ miniSkinId: 'hud' });
      });
      render(<MiniWindow />);
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-skin')).toBe('hud');
    });

    it('облик из снимка перебивает местный: настройка живёт в другом окне', () => {
      act(() => {
        usePlayerLayoutStore.setState({ miniSkinId: 'panel' });
      });
      render(<MiniWindow />);
      pipe.push(snapshot({ skin: 'neon' }));
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-skin')).toBe('neon');
    });

    it('снимок без облика ничего не меняет — старая сборка не сбрасывает вид', () => {
      act(() => {
        usePlayerLayoutStore.setState({ miniSkinId: 'vinyl' });
      });
      render(<MiniWindow />);
      pipe.push(snapshot());
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-skin')).toBe('vinyl');
    });

    it('состояние звука видно в разметке — на нём держится вращение пластинки', () => {
      render(<MiniWindow />);
      expect(screen.getByTestId('mini-window').getAttribute('data-playing')).toBe('false');
      pipe.push(snapshot({ isPlaying: true }));
      expect(screen.getByTestId('mini-window').getAttribute('data-playing')).toBe('true');
    });

    it('у обложки и ряда кнопок есть за что цепляться', () => {
      render(<MiniWindow />);
      const root = screen.getByTestId('mini-window');
      expect(root.querySelector('.mini-artwork'), 'обложка без класса').toBeTruthy();
      expect(root.querySelector('.mini-controls'), 'ряд кнопок без класса').toBeTruthy();
    });
  });

  describe('Выбор в настройках', () => {
    beforeEach(async () => {
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
      await dbService.clearAllData();
    });

    afterEach(() => {
      cleanup();
      vi.restoreAllMocks();
    });

    it('показывает все облики и отмечает выбранный', () => {
      render(<PlayerLayoutSettings />);
      const grid = screen.getByTestId('settings-mini-skins');
      expect(grid.querySelectorAll('[role="radio"]').length).toBe(MINI_SKIN_IDS.length);
      expect(
        screen.getByTestId(`settings-mini-skin-${DEFAULT_MINI_SKIN_ID}`).getAttribute('aria-checked')
      ).toBe('true');
    });

    it('нажатие меняет облик, а выбор облика полосы остаётся на месте', () => {
      render(<PlayerLayoutSettings />);
      const barSkinBefore = usePlayerLayoutStore.getState().skinId;
      fireEvent.click(screen.getByTestId('settings-mini-skin-poster'));

      expect(usePlayerLayoutStore.getState().miniSkinId).toBe('poster');
      expect(screen.getByTestId('settings-mini-skin-poster').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId(`settings-mini-skin-${DEFAULT_MINI_SKIN_ID}`).getAttribute('aria-checked')).toBe(
        'false'
      );
      // Две сетки рядом легко перепутать проводами: облик полосы не двинулся.
      expect(usePlayerLayoutStore.getState().skinId).toBe(barSkinBefore);
      expect(screen.getByTestId('settings-player-skins')).toBeTruthy();
    });
  });
});
