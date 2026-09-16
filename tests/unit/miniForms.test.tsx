import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import '../setup';
import { MiniWindow } from '../../src/components/player/mini/MiniWindow';
import { useMiniPlayerHost } from '../../src/hooks/useMiniPlayerHost';
import { usePlayerLayoutStore, PLAYER_LAYOUT_SETTING_KEYS } from '../../src/store/usePlayerLayoutStore';
import { DEFAULT_MINI_FORM_ID, MINI_FORM_IDS, MINI_FORMS, isMiniFormId } from '../../src/styles/miniForms';
import * as dbService from '../../src/services/db';
import { PlayerLayoutSettings } from '../../src/components/settings/PlayerLayoutSettings';
import type { MiniPlayerCommand, MiniPlayerState } from '../../src/types/electron';

/**
 * Формы мини-плеера: размер окна задаёт форма, и выбор живёт в основном окне.
 */

const ROOT = path.resolve(__dirname, '../..');
const MAIN_TS = readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8');
const MINI_CSS = readFileSync(path.join(ROOT, 'src/styles/mini.css'), 'utf8');

function snapshot(overrides: Partial<MiniPlayerState> = {}): MiniPlayerState {
  return {
    title: 'Ночная смена',
    artist: 'Гидропоника',
    artwork: 'https://example.com/night.jpg',
    isPlaying: false,
    currentTime: 45,
    duration: 200,
    volume: 0.5,
    isFavorite: false,
    shuffle: false,
    repeat: 'off',
    accent: null,
    ...overrides
  };
}

function installBridge() {
  const stateListeners = new Set<(state: MiniPlayerState) => void>();
  const commandListeners = new Set<(command: MiniPlayerCommand) => void>();
  const commands: MiniPlayerCommand[] = [];
  const hoverListeners = new Set<(over: boolean) => void>();
  const api = {
    isMiniWindow: true,
    closeMiniWindow: vi.fn().mockResolvedValue(true),
    setMiniForm: vi.fn().mockResolvedValue(true),
    setMiniShapeRect: vi.fn(),
    onMiniHover: (cb: (over: boolean) => void) => {
      hoverListeners.add(cb);
      return () => hoverListeners.delete(cb);
    },
    miniDragStart: vi.fn(),
    miniDragEnd: vi.fn(),
    onMiniState: (cb: (state: MiniPlayerState) => void) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onMiniCommand: (cb: (command: MiniPlayerCommand) => void) => {
      commandListeners.add(cb);
      return () => commandListeners.delete(cb);
    },
    onMiniWindowVisibility: () => () => undefined,
    sendMiniState: (state: MiniPlayerState) => stateListeners.forEach((cb) => cb(state)),
    sendMiniCommand: (command: MiniPlayerCommand) => {
      commands.push(command);
      commandListeners.forEach((cb) => cb(command));
    }
  };
  const previous = (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;
  return {
    api,
    commands,
    push: (state: MiniPlayerState) => act(() => api.sendMiniState(state)),
    /** Главный процесс увидел курсор над фигурой (или уход с неё). */
    hover: (over: boolean) => act(() => hoverListeners.forEach((cb) => cb(over))),
    restore: () => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = previous;
    }
  };
}

describe('Формы мини-плеера', () => {
  describe('Набор форм', () => {
    it('у каждой формы есть имя, подсказка и размер окна', () => {
      for (const id of MINI_FORM_IDS) {
        const form = MINI_FORMS[id];
        expect(form.name.length, id).toBeGreaterThan(0);
        expect(form.hint.length, id).toBeGreaterThan(10);
        expect(form.window.width, id).toBeGreaterThan(0);
        expect(form.window.height, id).toBeGreaterThan(0);
      }
      expect(isMiniFormId('disc')).toBe(true);
      expect(isMiniFormId('форма-из-старой-базы')).toBe(false);
    });

    it('главный процесс знает те же размеры окна — он собирается отдельно и копирует их', () => {
      for (const id of MINI_FORM_IDS) {
        const { width, height } = MINI_FORMS[id].window;
        expect(MAIN_TS, `размер «${id}» в electron/main.ts`).toContain(`${id}: { width: ${width}, height: ${height} }`);
      }
    });

    it('фигура каждой формы помещается в своё окно', () => {
      // Фигура шире окна обрезалась бы краем прозрачного окна без всякого признака.
      const px = (selector: string, prop: 'width' | 'height') => {
        const start = MINI_CSS.indexOf(selector);
        expect(start, `нет правила ${selector}`).toBeGreaterThan(-1);
        const body = MINI_CSS.slice(start, MINI_CSS.indexOf('}', start));
        const match = new RegExp(`${prop}: (\\d+)px`).exec(body);
        return Number(match?.[1]);
      };
      for (const id of MINI_FORM_IDS) {
        const selector =
          id === 'island'
            ? "[data-mini-form='island'] .mini-shape[data-expanded='true']"
            : `[data-mini-form='${id}'] .mini-shape`;
        expect(px(selector, 'width'), `ширина «${id}»`).toBeLessThanOrEqual(MINI_FORMS[id].window.width);
        expect(px(selector, 'height'), `высота «${id}»`).toBeLessThanOrEqual(MINI_FORMS[id].window.height);
      }
    });

    it('ползунок громкости сильнее общего правила ползунков — иначе он растягивается на кнопки', () => {
      expect(MINI_CSS).toContain('.mini-volume-group input.mini-volume {');
    });

    it('прозрачное окно не закрашено фоном документа и подсветом верха', () => {
      expect(MINI_CSS).toContain('html[data-mini-window] body');
      expect(MINI_CSS).toContain('html[data-mini-window] #root::before');
    });
  });

  describe('Окно', () => {
    let bridge: ReturnType<typeof installBridge>;

    beforeEach(() => {
      bridge = installBridge();
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
    });

    afterEach(() => {
      cleanup();
      bridge.restore();
      vi.useRealTimers();
    });

    it('по умолчанию — «Карточка», и окно просит размер под неё', () => {
      render(<MiniWindow />);
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-form')).toBe(DEFAULT_MINI_FORM_ID);
      expect(bridge.api.setMiniForm).toHaveBeenCalledWith(DEFAULT_MINI_FORM_ID);
    });

    it('форма из снимка перебивает местную и меняет размер окна', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ form: 'disc' }));
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-form')).toBe('disc');
      expect(bridge.api.setMiniForm).toHaveBeenLastCalledWith('disc');
    });

    it('испорченная форма в снимке не ломает окно', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ form: 'квадратное-колесо' as never }));
      expect(screen.getByTestId('mini-window').getAttribute('data-mini-form')).toBe(DEFAULT_MINI_FORM_ID);
    });

    it('каждая форма рисует транспорт и название', () => {
      for (const form of MINI_FORM_IDS) {
        const { unmount } = render(<MiniWindow />);
        bridge.push(snapshot({ form }));
        expect(screen.getByTestId('mini-window-play'), form).toBeTruthy();
        expect(screen.getByTestId('mini-window-next'), form).toBeTruthy();
        expect(screen.getByTestId('mini-window-close'), form).toBeTruthy();
        unmount();
      }
    });

    it('значок фигур переключает на следующую форму по кругу', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ form: 'disc' }));
      fireEvent.click(screen.getByTestId('mini-window-form'));
      // «Диск» последний — дальше снова первая форма.
      expect(bridge.commands.at(-1)).toEqual({ type: 'set-form', form: MINI_FORM_IDS[0] });
    });

    it('колёсико над плеером меняет громкость и показывает плашку', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ volume: 0.5 }));
      const shape = screen.getByTestId('mini-window').querySelector('.mini-shape') as HTMLElement;

      fireEvent.wheel(shape, { deltaY: -100 });
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 0.55 });
      expect(shape.querySelector('.mini-hud')?.getAttribute('data-visible')).toBe('true');

      fireEvent.wheel(shape, { deltaY: 100 });
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 0.5 });
    });

    it('громкость колёсиком не выходит за 0 и 100%', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ volume: 1 }));
      const shape = screen.getByTestId('mini-window').querySelector('.mini-shape') as HTMLElement;
      fireEvent.wheel(shape, { deltaY: -100 });
      expect(bridge.commands.at(-1)).toEqual({ type: 'volume', value: 1 });
    });

    it('окно сообщает главному процессу, где лежит фигура', () => {
      render(<MiniWindow />);
      bridge.push(snapshot());
      // Без этого прямоугольника главному процессу не с чем сравнивать курсор,
      // а своих событий мыши у сквозного окна нет вовсе.
      expect(bridge.api.setMiniShapeRect).toHaveBeenCalled();
      const rect = (bridge.api.setMiniShapeRect as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      expect(rect).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number)
      });
    });

    it('курсор над фигурой раскрывает остров, уход сворачивает его с задержкой', () => {
      vi.useFakeTimers();
      render(<MiniWindow />);
      bridge.push(snapshot({ form: 'island' }));
      const shape = screen.getByTestId('mini-window').querySelector('.mini-shape') as HTMLElement;

      bridge.hover(true);
      expect(shape.getAttribute('data-expanded')).toBe('true');
      // По этому признаку раскрываются и кнопки окна: `:hover` в сквозном окне
      // не срабатывает, о курсоре сообщает главный процесс.
      expect(shape.getAttribute('data-hover')).toBe('true');

      bridge.hover(false);
      // Схлопывается не сразу: соскочивший на пиксель курсор не должен дёргать остров.
      expect(shape.getAttribute('data-expanded')).toBe('true');
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(shape.getAttribute('data-expanded')).toBe('false');
    });

    it('перетаскивание за фигуру ведёт окно, а нажатие на кнопку — нет', () => {
      render(<MiniWindow />);
      bridge.push(snapshot());
      const shape = screen.getByTestId('mini-window').querySelector('.mini-shape') as HTMLElement;

      fireEvent.pointerDown(screen.getByTestId('mini-window-play'), { button: 0 });
      expect(bridge.api.miniDragStart).not.toHaveBeenCalled();

      fireEvent.pointerDown(shape, { button: 0, pointerId: 1 });
      expect(bridge.api.miniDragStart).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(shape, { pointerId: 1 });
      expect(bridge.api.miniDragEnd).toHaveBeenCalledTimes(1);
    });

    it('лайк отзывается анимацией только на включение, а не при открытии окна', () => {
      render(<MiniWindow />);
      bridge.push(snapshot({ isFavorite: true }));
      expect(screen.getByTestId('mini-window-favorite').hasAttribute('data-pop')).toBe(false);

      bridge.push(snapshot({ isFavorite: false }));
      bridge.push(snapshot({ isFavorite: true }));
      expect(screen.getByTestId('mini-window-favorite').hasAttribute('data-pop')).toBe(true);
    });
  });

  describe('Выбор в настройках', () => {
    beforeEach(() => {
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
    });

    afterEach(() => cleanup());

    it('в настройках плеера видны все формы, и выбранная отмечена', () => {
      render(<PlayerLayoutSettings />);
      const grid = screen.getByTestId('settings-mini-form-skins');
      expect(grid.querySelectorAll('[role="radio"]').length).toBe(MINI_FORM_IDS.length);
      expect(
        screen.getByTestId(`settings-mini-form-skin-${DEFAULT_MINI_FORM_ID}`).getAttribute('aria-checked')
      ).toBe('true');
      // Имя формы должно читаться глазами: по нему её и выбирают.
      expect(grid.textContent).toContain(MINI_FORMS.island.name);
    });

    it('нажатие меняет форму, облик мини-плеера при этом не двигается', () => {
      render(<PlayerLayoutSettings />);
      const skinBefore = usePlayerLayoutStore.getState().miniSkinId;
      fireEvent.click(screen.getByTestId('settings-mini-form-skin-island'));

      expect(usePlayerLayoutStore.getState().miniFormId).toBe('island');
      expect(usePlayerLayoutStore.getState().miniSkinId).toBe(skinBefore);
    });
  });

  describe('Основное окно', () => {
    let bridge: ReturnType<typeof installBridge>;

    function Host() {
      useMiniPlayerHost();
      return null;
    }

    beforeEach(async () => {
      bridge = installBridge();
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
    });

    afterEach(() => {
      cleanup();
      bridge.restore();
    });

    it('команда из мини-окна меняет настройку, а чужая форма — нет', async () => {
      render(<Host />);
      await act(async () => {
        bridge.api.sendMiniCommand({ type: 'set-form', form: 'cover' });
        await Promise.resolve();
      });
      expect(usePlayerLayoutStore.getState().miniFormId).toBe('cover');

      await act(async () => {
        bridge.api.sendMiniCommand({ type: 'set-form', form: 'пятиугольник' });
        await Promise.resolve();
      });
      expect(usePlayerLayoutStore.getState().miniFormId).toBe('cover');
    });

    it('выбор формы переживает перезапуск и сбрасывается вместе с разметкой', async () => {
      await dbService.clearAllData();
      usePlayerLayoutStore.getState().setMiniForm('bar');
      await vi.waitFor(async () => {
        expect(await dbService.getSetting(PLAYER_LAYOUT_SETTING_KEYS.miniFormId, null)).toBe('bar');
      });

      usePlayerLayoutStore.setState({ miniFormId: DEFAULT_MINI_FORM_ID, layoutHydrated: false });
      await usePlayerLayoutStore.getState().hydratePlayerLayout();
      expect(usePlayerLayoutStore.getState().miniFormId).toBe('bar');

      usePlayerLayoutStore.getState().resetLayout();
      expect(usePlayerLayoutStore.getState().miniFormId).toBe(DEFAULT_MINI_FORM_ID);
    });
  });
});
