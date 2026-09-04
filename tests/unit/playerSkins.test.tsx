import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../setup';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { PlayerLayoutSettings } from '../../src/components/settings/PlayerLayoutSettings';
import { usePlayerLayoutStore, PLAYER_LAYOUT_SETTING_KEYS } from '../../src/store/usePlayerLayoutStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import {
  DEFAULT_PLAYER_SKIN_ID,
  PLAYER_SKINS,
  PLAYER_SKIN_IDS,
  PLAYER_SKIN_LIST,
  PLAYER_SKIN_VAR_NAMES,
  isPlayerSkinId,
  playerSkinControls,
  playerSkinVars
} from '../../src/styles/playerSkins';
import {
  DENSITY_OPTIONS,
  DESIGN_PRESETS,
  NO_OVERRIDES,
  designVars,
  type DensityOverride
} from '../../src/styles/presets';
import { DEFAULT_ACCENT_HEX, DEFAULT_THEME_DEPTH } from '../../src/styles/palette';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Облики полосы плеера.
 *
 * Проверяется в первую очередь не внешность, а разделение обязанностей, на
 * котором вся затея держится: инлайновый стиль в этом проекте старше таблицы,
 * поэтому облик может подменить фон, радиус и высоту только через переменную,
 * которую `PlayerBar.tsx` подставляет себе сам. Стоит одному имени из набора
 * остаться непрочитанным — и облик «меняет» то, чего никто не читает: на экране
 * ничего не происходит, а в настройках переключатель есть.
 *
 * Отсюда чтение исходников с диска. В `vitest.config.ts` нет `css: true`, стили
 * в прогоне не обрабатываются вообще, и `getComputedStyle` про `--player-surface`
 * ничего не скажет. Так что проверяется причина, а не следствие.
 */

const SRC = path.resolve(__dirname, '../../src');
const PLAYER_BAR_TSX = readFileSync(path.join(SRC, 'components/player/PlayerBar.tsx'), 'utf8');
const PLAYER_CSS = readFileSync(path.join(SRC, 'styles/player.css'), 'utf8');
const THEME_CSS = readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8');

/** Число из значения вида `78px`. Всё, что не пиксели, — промах, а не ноль. */
function px(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec((value ?? '').trim());
  if (!match) throw new Error(`ожидалось значение в пикселях, пришло: ${value}`);
  return parseFloat(match[1]);
}

/** Размер органа управления из `theme.css` — там, где он и объявлен. */
function controlPx(name: string): number {
  const match = new RegExp(`--control-${name}:\\s*([^;]+);`).exec(THEME_CSS);
  if (!match) throw new Error(`--control-${name} не объявлен в theme.css`);
  return px(match[1]);
}

const CONTROL = { lg: controlPx('lg'), xl: controlPx('xl') };

/**
 * Высота ряда таймлайна.
 *
 * Своей переменной у него нет: высоту задаёт то, что выше — ползунок
 * (`--range-thumb-size`) или строка времени (`--text-xs` через межстрочный
 * интервал). Отсюда константа, но с проверкой ниже, чтобы она не разъехалась с
 * ползунком молча.
 */
const SEEK_ROW_HEIGHT = 16;

/** Сколько облик отнимает у полосы — в пикселях выбранного оформления. */
function subtractionOf(height: string, vars: Record<string, string>): number {
  if (height === 'var(--player-bar-height)') return 0;
  const match = /^calc\(var\(--player-bar-height\) - var\((--[a-z0-9-]+)\)\)$/.exec(height);
  if (!match) throw new Error(`непонятная высота облика: ${height}`);
  return px(vars[match[1]]);
}

const track: UnifiedTrack = {
  id: 'yt_skin_1',
  source: 'youtube',
  originalId: 'skin_1',
  title: 'Obsidian Drift',
  artist: 'Skin Tester',
  duration: 184,
  artworkUrl: 'https://example.com/skin.jpg'
};

function renderBarWithTrack(): void {
  act(() => {
    usePlayerStore.setState({ currentTrack: track, duration: track.duration });
  });
  render(<PlayerBar />);
}

describe('Облики полосы плеера', () => {
  describe('Набор переменных', () => {
    it('каждый облик задаёт все переменные и ни одной лишней', () => {
      for (const skin of PLAYER_SKIN_LIST) {
        const names = Object.keys(skin.vars).sort();
        expect(names, skin.id).toEqual([...PLAYER_SKIN_VAR_NAMES].sort());
        for (const name of PLAYER_SKIN_VAR_NAMES) {
          // Пустая строка страшнее отсутствующего ключа: она перебивает значение
          // по умолчанию из `:root`, и полоса остаётся без фона или без высоты.
          expect(skin.vars[name].trim().length, `${skin.id} ${name}`).toBeGreaterThan(0);
        }
      }
    });

    it('каждое имя из набора действительно читается полосой', () => {
      for (const name of PLAYER_SKIN_VAR_NAMES) {
        expect(PLAYER_BAR_TSX, name).toContain(`var(${name})`);
      }
    });

    it('у каждой переменной есть значение по умолчанию в :root', () => {
      // Облик может не быть выбран вовсе — например, до первого чтения базы.
      // Полоса при этом обязана выглядеть собранной, а не исчезнуть.
      const root = PLAYER_CSS.slice(PLAYER_CSS.indexOf(':root'), PLAYER_CSS.indexOf('}', PLAYER_CSS.indexOf(':root')));
      for (const name of PLAYER_SKIN_VAR_NAMES) {
        expect(root, name).toContain(`${name}:`);
      }
    });

    it('ни один облик не делает полосу выше отданной ей высоты', () => {
      // `--player-bar-height` пишет движок оформления, и по нему же три вида
      // отсчитывают отступ снизу. Полоса, ставшая выше, легла бы на содержимое.
      for (const skin of PLAYER_SKIN_LIST) {
        const height = skin.vars['--player-height'];
        expect(height, skin.id).toContain('var(--player-bar-height)');
        if (height !== 'var(--player-bar-height)') {
          expect(height, skin.id).toMatch(/^calc\(var\(--player-bar-height\) - /);
        }
      }
    });

    it('облик, отдавший высоту, обязан сжать и ряд транспорта', () => {
      // Ровно та поломка, которую было видно на «Парящей»: облик отнимал у полосы
      // 24 px, а кнопка транспорта с таймлайном оставались прежними и выходили за
      // скруглённый контур сверху и снизу. Обратное правило не проверяется:
      // облику позволено быть сжатым и во всю высоту.
      for (const skin of PLAYER_SKIN_LIST) {
        if (skin.vars['--player-height'] === 'var(--player-bar-height)') continue;
        expect(skin.tightControls, `${skin.id} отнимает высоту, но не сжимает содержимое`).toBe(true);
      }
    });

    it('содержимое умещается в полосу на любом пресете и любой плотности', () => {
      /*
       * Скрытая переменная, из-за которой облик выглядел целым на одном
       * оформлении и сломанным на другом: высоту полосе задаёт пресет (78–104 px),
       * а плотность ещё и растягивает шкалу отступов. Поэтому проверяется не одно
       * число, а весь квадрат «пресет × плотность» для каждого облика.
       *
       * Центральная зона полосы — столбец из ряда транспорта, зазора `--space-2` и
       * таймлайна, и её высота обязана уложиться в то, что осталось от полосы
       * после вычета облика.
       */
      const densities: (DensityOverride | undefined)[] = [undefined, ...DENSITY_OPTIONS.map((option) => option.id)];
      const tooTall: string[] = [];

      for (const preset of DESIGN_PRESETS) {
        for (const density of densities) {
          const vars = designVars({
            presetId: preset.id,
            depth: DEFAULT_THEME_DEPTH,
            accentHex: DEFAULT_ACCENT_HEX,
            overrides: { ...NO_OVERRIDES, density: density ?? null }
          });
          const bar = px(vars['--player-bar-height']);
          const columnGap = px(vars['--space-2']);

          for (const skin of PLAYER_SKIN_LIST) {
            const subtracted = subtractionOf(skin.vars['--player-height'], vars);
            const mainButton = skin.tightControls ? CONTROL.lg : CONTROL.xl;
            const content = mainButton + columnGap + SEEK_ROW_HEIGHT;
            if (bar - subtracted < content) {
              tooTall.push(
                `${skin.id} на «${preset.label}» (плотность ${density ?? 'пресета'}): ` +
                  `полоса ${bar - subtracted}px, содержимое ${content}px`
              );
            }
          }
        }
      }

      expect(tooTall, `кнопка и таймлайн выйдут за контур:\n${tooTall.join('\n')}`).toEqual([]);
    });

    it('оценка высоты таймлайна не ниже самого ползунка', () => {
      // Иначе проверка выше начнёт считать содержимое ниже, чем оно есть, и
      // пропустит ровно ту поломку, ради которой написана.
      const thumb = /--range-thumb-size:\s*([^;]+);/.exec(THEME_CSS);
      expect(thumb, '--range-thumb-size не объявлен').not.toBeNull();
      expect(px(thumb?.[1])).toBeLessThanOrEqual(SEEK_ROW_HEIGHT);
    });

    it('облики ссылаются только на существующие токены темы', () => {
      // Опечатка в имени токена не ломает сборку и не роняет тест раскладки: она
      // просто отдаёт пустое значение, и облик молча теряет фон или тень.
      const themeCss = readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8');
      const globalCss = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');
      const declared = `${themeCss}\n${globalCss}\n${PLAYER_CSS}`;

      for (const skin of PLAYER_SKIN_LIST) {
        for (const value of Object.values(skin.vars)) {
          for (const match of value.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
            expect(declared, `${skin.id}: ${match[1]}`).toContain(`${match[1]}:`);
          }
        }
      }
    });
  });

  describe('playerSkinVars', () => {
    it('отдаёт набор выбранного облика', () => {
      expect(playerSkinVars('float')).toEqual(PLAYER_SKINS.float.vars);
    });

    it('на неизвестном ключе отдаёт облик по умолчанию, а не пустой набор', () => {
      // Значение приходит из базы, то есть испортиться может. Пустой набор здесь
      // означал бы полосу без фона и без высоты — исчезнувший плеер.
      const vars = playerSkinVars('marble' as never);
      expect(vars).toEqual(PLAYER_SKINS[DEFAULT_PLAYER_SKIN_ID].vars);
    });
  });

  describe('playerSkinControls', () => {
    it('отдаёт сжатый ряд обликам, отдавшим высоту, и обычный — остальным', () => {
      for (const skin of PLAYER_SKIN_LIST) {
        expect(playerSkinControls(skin.id), skin.id).toBe(skin.tightControls ? 'tight' : 'compact');
      }
    });

    it('на неизвестном ключе отдаёт ряд облика по умолчанию, а не самый мелкий', () => {
      // Развилка та же, что у `playerSkinVars`: ключ приходит из базы. Мелкий ряд
      // в полной полосе выглядел бы не поломкой, а «так задумано» — и остался бы
      // незамеченным.
      expect(playerSkinControls('marble' as never)).toBe('compact');
    });

    it('полоса действительно передаёт ступень транспорту', () => {
      // Функция может быть верной и при этом никем не вызванной — именно так этот
      // разрыв и появился в первый раз.
      expect(PLAYER_BAR_TSX).toContain('variant={playerSkinControls(skinId)}');
    });
  });

  describe('isPlayerSkinId', () => {
    it('принимает все известные ключи', () => {
      for (const id of PLAYER_SKIN_IDS) expect(isPlayerSkinId(id)).toBe(true);
    });

    it('отбрасывает всё остальное', () => {
      for (const value of ['', 'BAR', 'marble', null, undefined, 7, {}, ['bar']]) {
        expect(isPlayerSkinId(value)).toBe(false);
      }
    });
  });

  describe('Правила в player.css', () => {
    it('каждый селектор облика назван существующим ключом', () => {
      const used = new Set<string>();
      for (const match of PLAYER_CSS.matchAll(/data-player-skin='([a-z]+)'/g)) used.add(match[1]);
      expect(used.size).toBeGreaterThan(0);
      for (const id of used) {
        expect(PLAYER_SKIN_IDS as readonly string[], id).toContain(id);
      }
    });

    it('бесконечное вращение пластинки отменяется при сокращённом движении', () => {
      const reduced = PLAYER_CSS.slice(PLAYER_CSS.indexOf('prefers-reduced-motion'));
      expect(reduced).toContain('animation: none');
    });

    it('у каждого облика есть название и подсказка на русском', () => {
      for (const skin of PLAYER_SKIN_LIST) {
        expect(skin.name.length, skin.id).toBeGreaterThan(2);
        expect(skin.hint.length, skin.id).toBeGreaterThan(10);
        expect(skin.name, skin.id).toMatch(/[а-яА-Я]/);
        expect(skin.hint, skin.id).toMatch(/[а-яА-Я]/);
      }
    });
  });

  describe('Полоса', () => {
    beforeEach(async () => {
      resetPlayerStore();
      resetLibraryStore();
      resetUIStore();
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
      await dbService.clearAllData();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('несёт класс и ключ облика, чтобы правила из таблицы до неё доставали', () => {
      renderBarWithTrack();

      const bar = screen.getByTestId('player-bar');
      expect(bar.className).toContain('wireon-player-bar');
      expect(bar.getAttribute('data-player-skin')).toBe(DEFAULT_PLAYER_SKIN_ID);
    });

    it('подставляет переменные выбранного облика в инлайновый стиль', () => {
      act(() => {
        usePlayerLayoutStore.getState().setPlayerSkin('float');
      });
      renderBarWithTrack();

      const bar = screen.getByTestId('player-bar');
      expect(bar.getAttribute('data-player-skin')).toBe('float');
      const style = bar.getAttribute('style') ?? '';
      for (const name of PLAYER_SKIN_VAR_NAMES) {
        expect(style, name).toContain(`${name}: ${PLAYER_SKINS.float.vars[name]}`);
      }
    });

    it('структурные свойства взяты из переменных, а не заданы числом', () => {
      renderBarWithTrack();

      const bar = screen.getByTestId('player-bar') as HTMLElement;
      expect(bar.style.backgroundColor).toBe('var(--player-surface)');
      expect(bar.style.borderTop).toBe('var(--player-border-top)');
      expect(bar.style.borderRadius).toBe('var(--player-radius)');
      expect(bar.style.height).toBe('var(--player-height)');
      expect(bar.style.left).toBe('var(--player-inset)');
      expect(bar.style.right).toBe('var(--player-inset)');
    });

    it('состояние воспроизведения приходит атрибутом', () => {
      // «Винил» вращает обложку, пока идёт звук, и снимает анимацию только
      // атрибутом: смена самой анимации дёргала бы пластинку в начало.
      renderBarWithTrack();
      expect(screen.getByTestId('player-bar').getAttribute('data-playing')).toBe('false');

      act(() => {
        usePlayerStore.setState({ isPlaying: true });
      });
      expect(screen.getByTestId('player-bar').getAttribute('data-playing')).toBe('true');
    });

    it('зоны и обложка помечены классами, за которые цепляется облик', () => {
      renderBarWithTrack();

      const bar = screen.getByTestId('player-bar');
      for (const cls of ['player-zone-meta', 'player-zone-center', 'player-zone-side']) {
        expect(bar.querySelector(`.${cls}`), cls).toBeTruthy();
      }
      // Обложка бывает и кнопкой, и плашкой — класс нужен на обеих.
      expect(bar.querySelector('.player-artwork')).toBeTruthy();
    });
  });

  describe('Выбор в настройках', () => {
    beforeEach(async () => {
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
      await dbService.clearAllData();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('показывает каждый облик и помечает выбранный', () => {
      render(<PlayerLayoutSettings />);

      for (const skin of PLAYER_SKIN_LIST) {
        const card = screen.getByTestId(`settings-player-skin-${skin.id}`);
        expect(card.textContent, skin.id).toContain(skin.name);
        expect(card.getAttribute('aria-checked')).toBe(String(skin.id === DEFAULT_PLAYER_SKIN_ID));
      }
    });

    it('нажатие переключает облик', () => {
      render(<PlayerLayoutSettings />);

      fireEvent.click(screen.getByTestId('settings-player-skin-vinyl'));

      expect(usePlayerLayoutStore.getState().skinId).toBe('vinyl');
      expect(screen.getByTestId('settings-player-skin-vinyl').getAttribute('aria-checked')).toBe('true');
      expect(screen.getByTestId(`settings-player-skin-${DEFAULT_PLAYER_SKIN_ID}`).getAttribute('aria-checked')).toBe(
        'false'
      );
    });
  });

  describe('Хранение выбора', () => {    beforeEach(async () => {
      usePlayerLayoutStore.getState().resetLayout();
      usePlayerLayoutStore.setState({ layoutHydrated: true });
      await dbService.clearAllData();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('setPlayerSkin запоминает выбор в базе', async () => {
      act(() => {
        usePlayerLayoutStore.getState().setPlayerSkin('deck');
      });
      expect(usePlayerLayoutStore.getState().skinId).toBe('deck');

      const stored = await dbService.getSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, null);
      expect(stored).toBe('deck');
    });

    it('чтение базы поднимает сохранённый облик', async () => {
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, 'glass');
      usePlayerLayoutStore.setState({ layoutHydrated: false });

      await usePlayerLayoutStore.getState().hydratePlayerLayout();

      expect(usePlayerLayoutStore.getState().skinId).toBe('glass');
    });

    it('испорченное значение из базы не доходит до полосы', async () => {
      await dbService.setSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, { id: 'glass' });
      usePlayerLayoutStore.setState({ layoutHydrated: false });

      await usePlayerLayoutStore.getState().hydratePlayerLayout();

      expect(usePlayerLayoutStore.getState().skinId).toBe(DEFAULT_PLAYER_SKIN_ID);
    });

    it('сброс раскладки возвращает облик по умолчанию', async () => {
      act(() => {
        usePlayerLayoutStore.getState().setPlayerSkin('vinyl');
      });

      act(() => {
        usePlayerLayoutStore.getState().resetLayout();
      });

      expect(usePlayerLayoutStore.getState().skinId).toBe(DEFAULT_PLAYER_SKIN_ID);
      const stored = await dbService.getSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, null);
      expect(stored).toBe(DEFAULT_PLAYER_SKIN_ID);
    });
  });
});
