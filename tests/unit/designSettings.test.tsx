import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { DesignSettings } from '../../src/components/settings/DesignSettings';
import { useThemeStore, THEME_SETTING_KEYS } from '../../src/store/useThemeStore';
import {
  DESIGN_PRESETS,
  DEFAULT_PRESET_ID,
  NO_OVERRIDES,
  findPreset
} from '../../src/styles/presets';
import { FONT_OPTIONS, DEFAULT_FONT_ID, fontStack } from '../../src/styles/typography';
import { flushAsync } from '../helpers/testUtils';
import * as dbService from '../../src/services/db';

/**
 * Раздел «Оформление».
 *
 * Проверяется не вид, а три места, где настройка внешности ломается тихо:
 *
 *   • пункт «Как в пресете» обязан означать `null`, а не одно из значений.
 *     Стоит ему стать «обычным» — и ручка навсегда прилипает к своему значению,
 *     а смена пресета перестаёт быть видна в половине приложения;
 *
 *   • пресет подтягивает свою гарнитуру только пока шрифт не выбран руками.
 *     Иначе выбор человека молча отменяется на каждой смене пресета;
 *
 *   • стекло и зерно пресет хранит числами, а ручка — да/нет. Ноль в пресете
 *     означает «выключено», и флажок обязан показывать именно это.
 */

/** Состояние оформления к исходному — стор живёт между тестами модулем. */
function resetTheme(): void {
  act(() => {
    useThemeStore.setState({
      presetId: DEFAULT_PRESET_ID,
      fontId: DEFAULT_FONT_ID,
      typeScaleId: 'normal',
      fontWeightId: 'normal',
      letterSpacingId: 'normal',
      overrides: { ...NO_OVERRIDES }
    });
  });
}

describe('Раздел «Оформление»', () => {
  beforeEach(async () => {
    resetTheme();
    await dbService.clearAllData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Пресеты', () => {
    it('показывает все пресеты и помечает выбранный', () => {
      render(<DesignSettings />);

      for (const preset of DESIGN_PRESETS) {
        const card = screen.getByTestId(`settings-design-preset-${preset.id}`);
        expect(card.textContent, preset.id).toContain(preset.label);
        expect(card.getAttribute('aria-checked')).toBe(String(preset.id === DEFAULT_PRESET_ID));
      }
    });

    it('каждый пресет показан своей миниатюрой, а не общей картинкой', () => {
      render(<DesignSettings />);

      for (const preset of DESIGN_PRESETS) {
        const preview = screen.getByTestId(`settings-design-preview-${preset.id}`);

        // Скругление сверяется с таблицей пресетов: миниатюра обязана считаться
        // из тех же значений, что и окно, иначе она обещает не то, что
        // применится по нажатию.
        expect(preview.style.getPropertyValue('--radius-sm'), preset.id).toBe(`${preset.radius[1]}px`);
        expect(preview.style.getPropertyValue('--bg-base'), preset.id).not.toBe('');

        // Словами карточка уже всё сказала — для чтения с экрана картинка лишняя.
        expect(preview.getAttribute('aria-hidden'), preset.id).toBe('true');
      }
    });

    it('миниатюра считает и ручки, а не только пресет', () => {
      act(() => {
        useThemeStore.setState({ overrides: { ...NO_OVERRIDES, radius: 'sharp' } });
      });

      render(<DesignSettings />);

      // Ручка старше пресета и переживёт его смену, поэтому под «Острыми» углами
      // все миниатюры обязаны стать острыми: иначе карточка обещает скругление,
      // которого после нажатия не будет.
      const radii = DESIGN_PRESETS.map((preset) =>
        screen.getByTestId(`settings-design-preview-${preset.id}`).style.getPropertyValue('--radius-sm')
      );

      expect(new Set(radii).size).toBe(1);
      expect(radii[0]).toBe('4px');
    });

    it('нажатие меняет пресет и запоминает его', async () => {
      render(<DesignSettings />);

      fireEvent.click(screen.getByTestId('settings-design-preset-neon'));

      expect(useThemeStore.getState().presetId).toBe('neon');
      // Запись в базу пущена без ожидания, поэтому одного микротакта не хватает.
      await flushAsync();
      expect(await dbService.getSetting(THEME_SETTING_KEYS.preset, null)).toBe('neon');
    });

    it('пресет подтягивает свою гарнитуру, пока шрифт не выбран руками', () => {
      render(<DesignSettings />);

      fireEvent.click(screen.getByTestId('settings-design-preset-aurora'));

      expect(useThemeStore.getState().fontId).toBe(findPreset('aurora').fontId);
    });

    it('выбранный руками шрифт переживает смену пресета', () => {
      render(<DesignSettings />);

      // «Unbounded» не является гарнитурой ни одного пресета, поэтому совпадение
      // с новым пресетом не может выдать ошибку за успех.
      fireEvent.click(screen.getByTestId('settings-design-font-unbounded'));
      fireEvent.click(screen.getByTestId('settings-design-preset-paper'));

      expect(useThemeStore.getState().fontId).toBe('unbounded');
    });
  });

  describe('Шрифт', () => {
    it('образец каждой гарнитуры набран ей же', () => {
      render(<DesignSettings />);

      for (const font of FONT_OPTIONS) {
        const card = screen.getByTestId(`settings-design-font-${font.id}`);
        const sample = card.firstElementChild as HTMLElement;
        // Сравнивается первая гарнитура набора, а не вся строка: кавычки в
        // значении `font-family` нормализуются и браузером, и jsdom.
        const first = fontStack(font.id).split(',')[0].replace(/['"]/g, '').trim();
        expect(sample.style.fontFamily, font.id).toContain(first);
      }
    });

    it('кегль, насыщенность и разрядка сохраняются по отдельности', async () => {
      render(<DesignSettings />);

      fireEvent.change(screen.getByTestId('settings-design-type-scale'), { target: { value: 'large' } });
      fireEvent.change(screen.getByTestId('settings-design-font-weight'), { target: { value: 'bold' } });
      fireEvent.change(screen.getByTestId('settings-design-letter-spacing'), { target: { value: 'wide' } });

      const state = useThemeStore.getState();
      expect(state.typeScaleId).toBe('large');
      expect(state.fontWeightId).toBe('bold');
      expect(state.letterSpacingId).toBe('wide');

      await flushAsync();
      expect(await dbService.getSetting(THEME_SETTING_KEYS.typeScale, null)).toBe('large');
      expect(await dbService.getSetting(THEME_SETTING_KEYS.fontWeight, null)).toBe('bold');
      expect(await dbService.getSetting(THEME_SETTING_KEYS.letterSpacing, null)).toBe('wide');
    });
  });

  describe('Ручки', () => {
    it('нетронутая ручка стоит на «как в пресете»', () => {
      render(<DesignSettings />);

      for (const id of ['radius', 'density', 'motion', 'particles']) {
        const select = screen.getByTestId(`settings-design-${id}`) as HTMLSelectElement;
        expect(select.value, id).toBe('');
      }
    });

    it('выбор значения пишет ручку, а «как в пресете» возвращает null', () => {
      render(<DesignSettings />);

      const radius = screen.getByTestId('settings-design-radius');
      fireEvent.change(radius, { target: { value: 'pill' } });
      expect(useThemeStore.getState().overrides.radius).toBe('pill');

      fireEvent.change(radius, { target: { value: '' } });
      // Именно `null`, а не строка: пустая строка прошла бы проверку типа в базе
      // и осталась бы «выбранным» значением, которого нет в лестнице.
      expect(useThemeStore.getState().overrides.radius).toBeNull();
    });

    it('каждая ручка пишет только своё поле', () => {
      render(<DesignSettings />);

      fireEvent.change(screen.getByTestId('settings-design-density'), { target: { value: 'airy' } });
      fireEvent.change(screen.getByTestId('settings-design-motion'), { target: { value: 'instant' } });
      fireEvent.change(screen.getByTestId('settings-design-particles'), { target: { value: 'storm' } });

      const overrides = useThemeStore.getState().overrides;
      expect(overrides).toMatchObject({
        radius: null,
        density: 'airy',
        motion: 'instant',
        particles: 'storm'
      });
    });

    it('ручка переживает смену пресета', () => {
      render(<DesignSettings />);

      fireEvent.change(screen.getByTestId('settings-design-motion'), { target: { value: 'slow' } });
      fireEvent.click(screen.getByTestId('settings-design-preset-obsidian'));

      expect(useThemeStore.getState().overrides.motion).toBe('slow');
    });

    it('флажки стекла и зерна показывают значение пресета, пока их не трогали', () => {
      render(<DesignSettings />);

      const preset = findPreset(DEFAULT_PRESET_ID);
      const glass = screen.getByTestId('setting-design-glass') as HTMLInputElement;
      const grain = screen.getByTestId('setting-design-grain') as HTMLInputElement;

      expect(glass.checked).toBe(preset.glassBlur > 0);
      expect(grain.checked).toBe(preset.grain > 0);
    });

    it('«Под пресет» недоступна, пока ни одна ручка не тронута', () => {
      render(<DesignSettings />);

      const reset = screen.getByTestId('settings-design-reset-overrides') as HTMLButtonElement;
      expect(reset.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('settings-design-radius'), { target: { value: 'sharp' } });
      expect((screen.getByTestId('settings-design-reset-overrides') as HTMLButtonElement).disabled).toBe(false);
    });

    it('«Под пресет» возвращает все ручки под пресет', () => {
      render(<DesignSettings />);

      fireEvent.change(screen.getByTestId('settings-design-radius'), { target: { value: 'sharp' } });
      fireEvent.change(screen.getByTestId('settings-design-particles'), { target: { value: 'off' } });
      fireEvent.click(screen.getByTestId('setting-design-glass'));

      fireEvent.click(screen.getByTestId('settings-design-reset-overrides'));

      expect(useThemeStore.getState().overrides).toEqual(NO_OVERRIDES);
    });
  });
});
