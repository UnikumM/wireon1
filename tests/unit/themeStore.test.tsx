import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '../setup';

import { AppearanceSettings } from '../../src/components/settings/AppearanceSettings';
import { useThemeStore, resolveAccentHex, THEME_SETTING_KEYS } from '../../src/store/useThemeStore';
import * as dbService from '../../src/services/db';
import {
  ACCENT_CSS_VARS,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HEX,
  DEFAULT_ACCENT_ID,
  DEFAULT_THEME_DEPTH,
  contrastRatio,
  pickTextOnAccent,
  type ThemeDepth
} from '../../src/styles/palette';
import { DEFAULT_PRESET_ID, findPreset } from '../../src/styles/presets';
import { usePlayerLayoutStore } from '../../src/store/usePlayerLayoutStore';
import { DEFAULT_PLAYER_SKIN_ID } from '../../src/styles/playerSkins';
import { flushAsync } from '../helpers/testUtils';

/**
 * Выбор оформления: хранилище и его страница в настройках.
 *
 * Проверяется не «состояние поменялось», а то, ради чего всё делалось: цвет
 * доехал до документа, выбор сохранился в базу и вернулся после перезапуска.
 * Первое без второго — тема, которая забывается, второе без первого — настройка,
 * которой не видно.
 */

const theme = () => useThemeStore.getState();
const root = () => document.documentElement;

/** Серый ровно той светлоты, при которой оба варианта подписи ниже AA. */
const UNREADABLE_GREY = '#797979';

function resetThemeStore(): void {
  useThemeStore.setState({
    accentId: DEFAULT_ACCENT_ID,
    customAccentHex: null,
    depth: DEFAULT_THEME_DEPTH,
    // Пресет тоже: два из них держат глубину, и утёкший «Неон» погасил бы
    // переключатели глубины в тесте, который про глубину и не спрашивал.
    presetId: DEFAULT_PRESET_ID
  });
  for (const name of Object.values(ACCENT_CSS_VARS)) {
    root().style.removeProperty(name);
  }
  delete root().dataset.theme;
}

describe('Тема: хранилище и настройки внешнего вида', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    resetThemeStore();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    // Сначала снять дерево, потом сбрасывать хранилище: живой компонент, которому
    // состояние меняют после теста, React считает обновлением вне act.
    cleanup();
    await flushAsync();
    resetThemeStore();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // ==========================================================================
  // useThemeStore
  // ==========================================================================
  describe('useThemeStore', () => {
    it('применяет пресет к документу и запоминает его', async () => {
      theme().setAccent('mint');

      expect(theme().accentId).toBe('mint');
      expect(root().style.getPropertyValue('--accent')).toBe('#8fe0c8');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.accentId, null)).toBe('mint')
      );
    });

    /**
     * «Дымка» без стеклянной полосы — половина пресета.
     *
     * Владелец показал снимок, где название трека уходит под полосу плеера и
     * растворяется в ней, и попросил тему с таким видом. Полоса — самая большая
     * поверхность в окне, и просвечивать должна в первую очередь она. Но выбор
     * человека старше: если облик уже меняли руками, пресет его не трогает.
     */
    it('«Дымка» приводит с собой стеклянную полосу плеера', async () => {
      const layout = usePlayerLayoutStore.getState();
      layout.setPlayerSkin(DEFAULT_PLAYER_SKIN_ID);
      useThemeStore.setState({ presetId: 'island' });

      useThemeStore.getState().setPreset('haze');
      await flushAsync();

      expect(useThemeStore.getState().presetId).toBe('haze');
      expect(usePlayerLayoutStore.getState().skinId).toBe('glass');
    });

    it('облик, выбранный руками, пресет не перебивает', async () => {
      usePlayerLayoutStore.getState().setPlayerSkin('vinyl');
      useThemeStore.setState({ presetId: 'island' });

      useThemeStore.getState().setPreset('haze');
      await flushAsync();

      expect(usePlayerLayoutStore.getState().skinId).toBe('vinyl');
    });

    it('свой цвет старше пресета, а выбор пресета его стирает', async () => {
      theme().setCustomAccent('#f0f');

      expect(theme().customAccentHex).toBe('#ff00ff');
      expect(resolveAccentHex(theme())).toBe('#ff00ff');
      expect(root().style.getPropertyValue('--accent')).toBe('#ff00ff');

      theme().setAccent('rose');

      // Иначе нажатие на образец не давало бы никакого видимого результата:
      // свой цвет продолжал бы перебивать выбранный пресет.
      expect(theme().customAccentHex).toBeNull();
      expect(root().style.getPropertyValue('--accent')).toBe('#f2a3bd');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.customAccentHex, 'не спрашивали')).toBeNull()
      );
    });

    it('незаконченный ввод и неизвестный пресет оставляют тему как есть', () => {
      theme().setAccent('mint');

      theme().setCustomAccent('#8f');
      theme().setAccent('такого пресета нет');

      expect(theme().accentId).toBe('mint');
      expect(theme().customAccentHex).toBeNull();
      expect(root().style.getPropertyValue('--accent')).toBe('#8fe0c8');
    });

    it('глубина уходит в data-theme и в базу, мусор отбрасывается', async () => {
      theme().setDepth('light');

      expect(root().dataset.theme).toBe('light');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.depth, null)).toBe('light')
      );

      theme().setDepth('неон' as ThemeDepth);

      expect(theme().depth).toBe('light');
      expect(root().dataset.theme).toBe('light');
    });

    it('восстанавливает сохранённый выбор и сразу применяет его', async () => {
      await dbService.setSetting(THEME_SETTING_KEYS.accentId, 'sand');
      await dbService.setSetting(THEME_SETTING_KEYS.depth, 'night');

      await theme().hydrateTheme();

      expect(theme().accentId).toBe('sand');
      expect(theme().depth).toBe('night');
      expect(root().style.getPropertyValue('--accent')).toBe('#e8c48f');
      expect(root().dataset.theme).toBe('night');
    });

    it('свой цвет переживает перезапуск', async () => {
      await dbService.setSetting(THEME_SETTING_KEYS.customAccentHex, '#b4d78f');

      await theme().hydrateTheme();

      expect(theme().customAccentHex).toBe('#b4d78f');
      expect(root().style.getPropertyValue('--accent')).toBe('#b4d78f');
    });

    it('читает базу один раз, даже если восстановление позвали дважды', async () => {
      const getSetting = vi.spyOn(dbService, 'getSetting');

      await Promise.all([theme().hydrateTheme(), theme().hydrateTheme()]);

      // По одному чтению на ключ, а не по два: второй вызов дожидается первого,
      // иначе окно перечитывало бы настройки на каждом повторном монтаже.
      // Число берётся из самой карты ключей — иначе проверка ломается каждый
      // раз, когда в оформление добавляется ещё одна настройка, и превращается
      // в счётчик ключей вместо проверки на повторное чтение.
      expect(getSetting).toHaveBeenCalledTimes(Object.keys(THEME_SETTING_KEYS).length);
    });

    it('без известного пресета и без своего цвета остаётся акцент по умолчанию', () => {
      expect(resolveAccentHex({ accentId: 'ультрамарин', customAccentHex: null })).toBe(
        DEFAULT_ACCENT_HEX
      );
    });

    it('битые значения в базе заменяет значениями по умолчанию по отдельности', async () => {
      await dbService.setSetting(THEME_SETTING_KEYS.accentId, 'ультрамарин');
      await dbService.setSetting(THEME_SETTING_KEYS.customAccentHex, 'не цвет');
      await dbService.setSetting(THEME_SETTING_KEYS.depth, 'неон');

      await theme().hydrateTheme();

      expect(theme().accentId).toBe(DEFAULT_ACCENT_ID);
      expect(theme().customAccentHex).toBeNull();
      expect(theme().depth).toBe(DEFAULT_THEME_DEPTH);
      expect(root().style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT_HEX);
      expect(root().dataset.theme).toBe(DEFAULT_THEME_DEPTH);
    });

    it('недоступная база не роняет запуск и всё равно оставляет тему применённой', async () => {
      vi.spyOn(dbService, 'getSetting').mockRejectedValue(new Error('IndexedDB blocked'));

      await expect(theme().hydrateTheme()).resolves.toBeUndefined();

      expect(root().style.getPropertyValue('--accent')).toBe(DEFAULT_ACCENT_HEX);
      expect(root().dataset.theme).toBe(DEFAULT_THEME_DEPTH);
    });

    it('ошибка сохранения не выходит наружу', () => {
      vi.spyOn(dbService, 'setSetting').mockRejectedValue(new Error('disk full'));

      expect(() => theme().setDepth('steel')).not.toThrow();
      expect(theme().depth).toBe('steel');
    });

    it('падение базы прямо в вызове тоже проглатывается', () => {
      // Отказ приходит двумя способами: обещанием и броском на месте (закрытая
      // база бросает синхронно). Настройка вида не повод останавливать интерфейс
      // ни в одном из них.
      vi.spyOn(dbService, 'setSetting').mockImplementation(() => {
        throw new Error('DatabaseClosedError');
      });

      expect(() => theme().setAccent('moss')).not.toThrow();
      expect(theme().accentId).toBe('moss');
      expect(root().style.getPropertyValue('--accent')).toBe('#b4d78f');
    });
  });

  // ==========================================================================
  // AppearanceSettings
  // ==========================================================================
  describe('AppearanceSettings', () => {
    it('нажатие на образец меняет акцент и в хранилище, и в документе', async () => {
      render(<AppearanceSettings />);

      fireEvent.click(screen.getByTestId('settings-accent-lilac'));

      expect(theme().accentId).toBe('lilac');
      expect(root().style.getPropertyValue('--accent')).toBe('#d3a9ec');
      // Оттенки состояний выводятся из выбранного цвета, а не берутся из CSS.
      expect(root().style.getPropertyValue('--accent-hover')).not.toBe('');
      expect(root().style.getPropertyValue('--ring-color')).toContain('rgba(211, 169, 236');
      expect(screen.getByTestId('settings-accent-lilac')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('settings-accent-ice')).toHaveAttribute('aria-pressed', 'false');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.accentId, null)).toBe('lilac')
      );
    });

    it('свой цвет вводится текстом и применяется сразу', async () => {
      render(<AppearanceSettings />);

      fireEvent.change(screen.getByTestId('settings-accent-hex'), { target: { value: '#7fb0f5' } });

      expect(theme().customAccentHex).toBe('#7fb0f5');
      expect(root().style.getPropertyValue('--accent')).toBe('#7fb0f5');
      // Ни один образец не выглядит нажатым: на экране цвет не из палитры.
      expect(screen.getByTestId('settings-accent-ice')).toHaveAttribute('aria-pressed', 'false');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.customAccentHex, null)).toBe('#7fb0f5')
      );
    });

    it('пипетка задаёт тот же цвет, что и поле', () => {
      render(<AppearanceSettings />);

      fireEvent.change(screen.getByTestId('settings-accent-color'), { target: { value: '#8fe0c8' } });

      expect(theme().customAccentHex).toBe('#8fe0c8');
      expect(screen.getByTestId('settings-accent-hex')).toHaveValue('#8fe0c8');
    });

    it('незаконченную запись объясняет, но акцент не гасит', () => {
      render(<AppearanceSettings />);

      fireEvent.change(screen.getByTestId('settings-accent-hex'), { target: { value: '#8f' } });

      expect(screen.getByTestId('settings-accent-hex-error')).toBeInTheDocument();
      // Поле показывает то, что напечатали, а тема остаётся прежней.
      expect(screen.getByTestId('settings-accent-hex')).toHaveValue('#8f');
      expect(theme().customAccentHex).toBeNull();
      expect(root().style.getPropertyValue('--accent')).toBe('');
    });

    it('о плохом контрасте предупреждает, но выбор не отменяет', () => {
      // Порог AA — 4.5:1, и этот серый не проходит ни с чёрной подписью, ни с белой.
      expect(contrastRatio(UNREADABLE_GREY, pickTextOnAccent(UNREADABLE_GREY))).toBeLessThan(4.5);

      render(<AppearanceSettings />);
      fireEvent.change(screen.getByTestId('settings-accent-hex'), { target: { value: UNREADABLE_GREY } });

      expect(screen.getByTestId('settings-accent-contrast-warning')).toBeInTheDocument();
      expect(theme().customAccentHex).toBe(UNREADABLE_GREY);
      expect(root().style.getPropertyValue('--accent')).toBe(UNREADABLE_GREY);
    });

    it('у пастельного акцента предупреждения нет', () => {
      render(<AppearanceSettings />);

      expect(screen.queryByTestId('settings-accent-contrast-warning')).toBeNull();
    });

    it('выбор глубины ставит data-theme на <html>', async () => {
      render(<AppearanceSettings />);

      fireEvent.click(screen.getByTestId('settings-theme-depth-steel'));

      expect(theme().depth).toBe('steel');
      expect(root().dataset.theme).toBe('steel');
      expect(screen.getByTestId('settings-theme-depth-steel')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('settings-theme-depth-state')).toHaveTextContent('Светлее сумерек');
      await waitFor(async () =>
        expect(await dbService.getSetting(THEME_SETTING_KEYS.depth, null)).toBe('steel')
      );
    });

    it('все четыре глубины и вся палитра доступны выбору', () => {
      render(<AppearanceSettings />);

      for (const id of ['night', 'dusk', 'steel', 'light']) {
        expect(screen.getByTestId(`settings-theme-depth-${id}`)).toBeInTheDocument();
      }
      // Одиннадцать, а не десять: к десяти пастельным добавилась «Лазурь» —
      // насыщенный голубой, который стал акцентом по умолчанию.
      expect(screen.getByRole('group', { name: 'Готовые акценты' }).childElementCount).toBe(
        ACCENT_PRESETS.length
      );
    });

    it('у каждой глубины свой образец подложки, а не общий цвет', () => {
      render(<AppearanceSettings />);

      // «Ночь» и «Сумерки» различаются несколькими пунктами светлоты: словами это
      // не разделить, поэтому кружок обязан показывать именно ту подложку, в
      // которую нажатие и перекрасит окно.
      const swatches = ['night', 'dusk', 'steel', 'light'].map((id) =>
        screen.getByTestId(`settings-theme-depth-swatch-${id}`).style.background
      );

      for (const [index, colour] of swatches.entries()) {
        expect(colour, `образец ${index} без цвета`).not.toBe('');
      }
      expect(new Set(swatches).size).toBe(4);
    });

    it('пресет, который держит глубину, гасит переключатели, а не врёт ими', () => {
      // «Бумага» существует только на белом, и `applyDesign` приводит глубину к
      // светлой независимо от выбора. Раньше нажатие всё равно принималось: чип
      // вставал нажатым, подпись менялась на «почти чёрная» — а окно оставалось
      // светлым. Два клика до органа управления, который обманывает.
      const paper = findPreset('paper');
      expect(paper.forceDepth).toBe('light');

      useThemeStore.setState({ presetId: 'paper' });
      render(<AppearanceSettings />);

      expect(screen.getByTestId('settings-theme-depth-light')).toHaveAttribute('aria-pressed', 'true');
      for (const id of ['night', 'dusk', 'steel', 'light']) {
        expect(screen.getByTestId(`settings-theme-depth-${id}`), id).toBeDisabled();
      }
      expect(screen.getByTestId('settings-theme-depth-locked')).toHaveTextContent('Бумага');
    });

    it('выбор глубины возвращается, когда пресет её отпускает', () => {
      // Раньше `setPreset` записывал требование пресета прямо в состояние, и
      // память о выборе стиралась: «Сумерки» → «Бумага» → назад к «Острову» —
      // и человек оставался в светлой теме, которой у «Острова» не просил.
      render(<AppearanceSettings />);
      fireEvent.click(screen.getByTestId('settings-theme-depth-night'));
      expect(root().dataset.theme).toBe('night');

      cleanup();
      useThemeStore.getState().setPreset('paper');
      expect(root().dataset.theme).toBe('light');
      expect(theme().depth).toBe('night');

      useThemeStore.getState().setPreset('island');
      expect(root().dataset.theme).toBe('night');

      render(<AppearanceSettings />);
      expect(screen.getByTestId('settings-theme-depth-night')).toHaveAttribute('aria-pressed', 'true');
    });

    it('переключатель визуализации остался на месте', () => {
      render(<AppearanceSettings />);

      expect(screen.getByTestId('settings-visualizer-preset')).toHaveValue('CYBER_BARS');
      expect(screen.getByRole('option', { name: 'Нет' })).toBeInTheDocument();
    });
  });
});
