import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '../setup';
import { CustomDesignsSection } from '../../src/components/settings/CustomDesignsSection';
import { useThemeStore, THEME_SETTING_KEYS } from '../../src/store/useThemeStore';
import { DEFAULT_PRESET_ID, NO_OVERRIDES } from '../../src/styles/presets';
import { DEFAULT_FONT_ID } from '../../src/styles/typography';
import { DEFAULT_ACCENT_ID, DEFAULT_THEME_DEPTH } from '../../src/styles/palette';
import {
  MAX_DESIGN_NAME,
  MAX_SAVED_DESIGNS,
  describeSnapshot,
  normalizeDesignName,
  parseSavedDesigns,
  parseSnapshot,
  snapshotsEqual,
  type DesignSnapshot,
  type SavedDesign
} from '../../src/styles/customDesigns';
import { flushAsync } from '../helpers/testUtils';
import * as dbService from '../../src/services/db';

/**
 * Свои оформления.
 *
 * Проверяется не «список пополнился», а то, ради чего снимки существуют: вид
 * восстанавливается целиком и переживает перезапуск. Половина этой затеи ломается
 * тихо и по одному полю за раз:
 *
 *   • снимок обязан хранить весь выбор. Забытое поле не роняет ничего — оно
 *     возвращается к значению по умолчанию, и «своё оформление» тихо теряет
 *     плотность или межбуквенное, о котором никто не вспомнит;
 *
 *   • применение обязано записывать каждое поле отдельным ключом. Иначе
 *     применённое оформление живёт до закрытия окна: список восстановится, а вид
 *     откатится к настройкам, которые никто не менял;
 *
 *   • разбор из базы обязан чинить запись по месту, а не выбрасывать. Одна битая
 *     гарнитура не должна стирать двенадцать подобранных оформлений.
 */

const theme = () => useThemeStore.getState();

const BASE: DesignSnapshot = {
  presetId: DEFAULT_PRESET_ID,
  depth: DEFAULT_THEME_DEPTH,
  accentId: DEFAULT_ACCENT_ID,
  customAccentHex: null,
  fontId: DEFAULT_FONT_ID,
  typeScaleId: 'normal',
  fontWeightId: 'normal',
  letterSpacingId: 'normal',
  overrides: { ...NO_OVERRIDES }
};

function resetTheme(): void {
  act(() => {
    useThemeStore.setState({ ...BASE, overrides: { ...NO_OVERRIDES }, savedDesigns: [] });
  });
}

/** Вид, отличающийся от исходного по каждому полю сразу — для проверки на полноту. */
function pickEverything(): void {
  act(() => {
    theme().setPreset('obsidian');
    theme().setDepth('light');
    theme().setAccent('mint');
    theme().setFont('unbounded');
    theme().setTypeScale('large');
    theme().setFontWeight('bold');
    theme().setLetterSpacing('wide');
    theme().setOverride('radius', 'pill');
    theme().setOverride('density', 'airy');
    theme().setOverride('motion', 'slow');
    theme().setOverride('particles', 'storm');
    theme().setOverride('glass', false);
    theme().setOverride('grain', false);
  });
}

describe('Свои оформления', () => {
  beforeEach(async () => {
    resetTheme();
    await dbService.clearAllData();
  });

  afterEach(async () => {
    cleanup();
    await flushAsync();
    resetTheme();
    vi.restoreAllMocks();
    if (!dbService.db.isOpen()) await dbService.db.open();
    await dbService.clearAllData();
  });

  // ==========================================================================
  // Модель
  // ==========================================================================
  describe('имя', () => {
    it('срезает пробелы по краям и схлопывает внутренние', () => {
      expect(normalizeDesignName('  Мой   тёмный  ')).toBe('Мой тёмный');
    });

    it('имя из одних пробелов не годится', () => {
      // Иначе в списке висит карточка без подписи: её нельзя ни узнать, ни назвать.
      expect(normalizeDesignName('   ')).toBeNull();
      expect(normalizeDesignName('')).toBeNull();
      expect(normalizeDesignName('\t\n ')).toBeNull();
    });

    it('слишком длинное имя обрезается, а не отвергается', () => {
      const long = 'я'.repeat(MAX_DESIGN_NAME + 20);
      expect(normalizeDesignName(long)).toHaveLength(MAX_DESIGN_NAME);
    });
  });

  describe('разбор снимка', () => {
    it('каждое поле падает до значения по умолчанию в одиночку', () => {
      // Смысл теста: одно испорченное поле не отменяет остальные. Здесь битая
      // гарнитура и мусор в глубине, но подобранный цвет и углы обязаны выжить.
      const parsed = parseSnapshot({
        presetId: 'obsidian',
        depth: 'нет такой',
        accentId: 'mint',
        customAccentHex: 'не цвет',
        fontId: 'мусор',
        typeScaleId: 'large',
        overrides: { radius: 'pill', density: 'нет такой' }
      });

      expect(parsed.presetId).toBe('obsidian');
      expect(parsed.typeScaleId).toBe('large');
      expect(parsed.accentId).toBe('mint');
      expect(parsed.overrides.radius).toBe('pill');
      // А испорченное — к значению по умолчанию, и ручка возвращается к `null`,
      // то есть «как в пресете», а не к чужому значению.
      expect(parsed.depth).toBe(DEFAULT_THEME_DEPTH);
      expect(parsed.customAccentHex).toBeNull();
      expect(parsed.overrides.density).toBeNull();
    });

    it('не падает на полном мусоре', () => {
      for (const raw of [null, undefined, 42, 'строка', []]) {
        expect(() => parseSnapshot(raw)).not.toThrow();
      }
      expect(parseSnapshot(null).presetId).toBe(DEFAULT_PRESET_ID);
    });
  });

  describe('разбор списка', () => {
    const entry = (id: string, name: string) => ({ id, name, snapshot: BASE });

    it('выбрасывает записи без имени и без идентификатора', () => {
      const list = parseSavedDesigns([
        entry('a', 'Первое'),
        { id: 'b', name: '   ' },
        { name: 'Без ключа', snapshot: BASE },
        { id: 'c', snapshot: BASE },
        entry('d', 'Второе')
      ]);

      expect(list.map((design) => design.name)).toEqual(['Первое', 'Второе']);
    });

    it('выбрасывает повторный идентификатор', () => {
      // Две карточки с одним ключом удаляются вместе: удаление ищет по ключу.
      const list = parseSavedDesigns([entry('a', 'Первое'), entry('a', 'Двойник')]);

      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Первое');
    });

    it('обрезает список по пределу', () => {
      const raw = Array.from({ length: MAX_SAVED_DESIGNS + 5 }, (_, i) => entry(`id-${i}`, `Вид ${i}`));

      expect(parseSavedDesigns(raw)).toHaveLength(MAX_SAVED_DESIGNS);
    });

    it('не список — пустой список', () => {
      for (const raw of [null, undefined, {}, 'строка']) expect(parseSavedDesigns(raw)).toEqual([]);
    });
  });

  describe('сравнение снимков', () => {
    it('различает снимки по каждому полю, включая ручки', () => {
      // Проверка нужна ровно из-за подсветки «сейчас применено это»: сравнение,
      // забывшее поле, показало бы применённым не то оформление, что на экране.
      const changes: Partial<DesignSnapshot>[] = [
        { presetId: 'obsidian' },
        { depth: 'light' },
        { accentId: 'mint' },
        { customAccentHex: '#8fc7ff' },
        { fontId: 'unbounded' },
        { typeScaleId: 'large' },
        { fontWeightId: 'bold' },
        { letterSpacingId: 'wide' },
        { overrides: { ...NO_OVERRIDES, radius: 'pill' } },
        { overrides: { ...NO_OVERRIDES, density: 'airy' } },
        { overrides: { ...NO_OVERRIDES, motion: 'slow' } },
        { overrides: { ...NO_OVERRIDES, particles: 'storm' } },
        { overrides: { ...NO_OVERRIDES, glass: false } },
        { overrides: { ...NO_OVERRIDES, grain: false } }
      ];

      expect(snapshotsEqual(BASE, { ...BASE, overrides: { ...NO_OVERRIDES } })).toBe(true);
      for (const change of changes) {
        expect(snapshotsEqual(BASE, { ...BASE, ...change }), JSON.stringify(change)).toBe(false);
      }
    });
  });

  describe('подпись', () => {
    it('перечисляет пресет, светлоту и шрифт, а из ручек — только тронутые', () => {
      const untouched = describeSnapshot(BASE);
      expect(untouched.split(' · ')).toHaveLength(3);

      const touched = describeSnapshot({ ...BASE, overrides: { ...NO_OVERRIDES, radius: 'pill' } });
      expect(touched).toContain('пилюли');
      // Нетронутые ручки в подписи не появляются: иначе отличие от пресета, ради
      // которого снимок и сохраняли, теряется среди восьми одинаковых слов.
      expect(touched).not.toContain('обычно');
    });
  });

  // ==========================================================================
  // Хранилище
  // ==========================================================================
  describe('хранилище', () => {
    it('снимок хранит весь выбор целиком', async () => {
      pickEverything();
      act(() => theme().saveDesign('Всё сразу'));

      const { snapshot } = theme().savedDesigns[0];
      // Сравнение с текущим состоянием, а не с перечислением полей: список полей
      // в тесте пришлось бы обновлять руками, и забытая ручка снова прошла бы.
      expect(snapshotsEqual(snapshot, theme())).toBe(true);
      expect(snapshot.overrides.grain).toBe(false);
      expect(snapshot.letterSpacingId).toBe('wide');
    });

    it('применение возвращает весь вид, а не его часть', () => {
      pickEverything();
      act(() => theme().saveDesign('Собранный'));
      const id = theme().savedDesigns[0].id;

      act(() => {
        theme().setPreset('paper');
        theme().setFont('system');
        theme().resetOverrides();
      });
      expect(snapshotsEqual(theme().savedDesigns[0].snapshot, theme())).toBe(false);

      act(() => theme().applySavedDesign(id));

      expect(snapshotsEqual(theme().savedDesigns[0].snapshot, theme())).toBe(true);
      expect(theme().overrides.particles).toBe('storm');
    });

    it('применённое оформление переживает перезапуск и без списка', async () => {
      // Каждое поле уходит в базу своим ключом — тем же, что у обычной настройки.
      // Иначе вид держится до закрытия окна: восстановление читает ключи, а не
      // список, и молча откатило бы всё к значениям по умолчанию.
      pickEverything();
      act(() => theme().saveDesign('Вечернее'));
      act(() => theme().applySavedDesign(theme().savedDesigns[0].id));
      await flushAsync();

      expect(await dbService.getSetting(THEME_SETTING_KEYS.preset, null)).toBe('obsidian');
      expect(await dbService.getSetting(THEME_SETTING_KEYS.letterSpacing, null)).toBe('wide');
      const stored = (await dbService.getSetting<{ particles: string } | null>(
        THEME_SETTING_KEYS.overrides,
        null
      )) as { particles: string };
      expect(stored.particles).toBe('storm');
    });

    it('список сохраняется в базу и восстанавливается разобранным', async () => {
      pickEverything();
      act(() => theme().saveDesign('Первое'));
      await flushAsync();

      const raw = await dbService.getSetting<SavedDesign[]>(THEME_SETTING_KEYS.savedDesigns, []);
      expect(raw).toHaveLength(1);
      expect(parseSavedDesigns(raw)[0].name).toBe('Первое');
      expect(snapshotsEqual(parseSavedDesigns(raw)[0].snapshot, theme())).toBe(true);
    });

    it('пустое имя ничего не сохраняет', () => {
      act(() => theme().saveDesign('   '));

      expect(theme().savedDesigns).toEqual([]);
    });

    it('список не растёт за предел', () => {
      act(() => {
        for (let i = 0; i < MAX_SAVED_DESIGNS + 4; i++) theme().saveDesign(`Вид ${i}`);
      });

      expect(theme().savedDesigns).toHaveLength(MAX_SAVED_DESIGNS);
      // Отброшены именно последние: первые сохранённые не должны вытесняться
      // молча — человек их назвал раньше и рассчитывает найти на месте.
      expect(theme().savedDesigns[0].name).toBe('Вид 0');
    });

    it('«обновить» переписывает снимок, но оставляет имя и место в списке', () => {
      act(() => {
        theme().saveDesign('Первое');
        theme().saveDesign('Второе');
      });
      const id = theme().savedDesigns[0].id;

      pickEverything();
      act(() => theme().updateSavedDesign(id));

      const [first, second] = theme().savedDesigns;
      expect(first.name).toBe('Первое');
      expect(first.id).toBe(id);
      expect(snapshotsEqual(first.snapshot, theme())).toBe(true);
      expect(snapshotsEqual(second.snapshot, theme())).toBe(false);
    });

    it('удаление сносит одно оформление', () => {
      act(() => {
        theme().saveDesign('Первое');
        theme().saveDesign('Второе');
      });

      act(() => theme().deleteSavedDesign(theme().savedDesigns[0].id));

      expect(theme().savedDesigns.map((design) => design.name)).toEqual(['Второе']);
    });

    it('неизвестный ключ ничего не портит', () => {
      act(() => theme().saveDesign('Первое'));
      const before = theme().savedDesigns;

      act(() => {
        theme().applySavedDesign('нет такого');
        theme().updateSavedDesign('нет такого');
        theme().deleteSavedDesign('нет такого');
      });

      expect(theme().savedDesigns).toEqual(before);
    });

    it('восстановление поднимает список из базы и чинит битые записи', async () => {
      await dbService.setSetting(THEME_SETTING_KEYS.savedDesigns, [
        { id: 'a', name: 'Живое', snapshot: { presetId: 'obsidian', fontId: 'мусор' } },
        { id: 'b', name: '  ' }
      ]);

      await act(async () => {
        await theme().hydrateTheme();
      });

      expect(theme().savedDesigns).toHaveLength(1);
      expect(theme().savedDesigns[0].snapshot.presetId).toBe('obsidian');
      // Битая гарнитура починена по месту, а не выброшена вместе с оформлением.
      expect(theme().savedDesigns[0].snapshot.fontId).toBeTruthy();
    });
  });

  // ==========================================================================
  // Раздел в настройках
  // ==========================================================================
  describe('раздел', () => {
    it('без сохранённых показывает, что делать', () => {
      render(<CustomDesignsSection />);

      expect(screen.getByTestId('settings-design-saved-empty')).toBeTruthy();
      expect(screen.queryByTestId('settings-design-saved-list')).toBeNull();
    });

    it('кнопка недоступна, пока имя не набрано', () => {
      render(<CustomDesignsSection />);
      const save = screen.getByTestId('settings-design-save') as HTMLButtonElement;

      expect(save.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('settings-design-save-name'), { target: { value: '   ' } });
      expect(save.disabled).toBe(true);

      fireEvent.change(screen.getByTestId('settings-design-save-name'), { target: { value: 'Мой' } });
      expect(save.disabled).toBe(false);
    });

    it('сохраняет по нажатию и очищает поле', () => {
      render(<CustomDesignsSection />);
      const input = screen.getByTestId('settings-design-save-name') as HTMLInputElement;

      fireEvent.change(input, { target: { value: 'Вечернее' } });
      fireEvent.click(screen.getByTestId('settings-design-save'));

      expect(theme().savedDesigns.map((design) => design.name)).toEqual(['Вечернее']);
      expect(input.value).toBe('');
      expect(screen.getByTestId('settings-design-saved-0').textContent).toContain('Вечернее');
    });

    it('Enter в поле имени сохраняет', () => {
      render(<CustomDesignsSection />);
      const input = screen.getByTestId('settings-design-save-name');

      fireEvent.change(input, { target: { value: 'С клавиатуры' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(theme().savedDesigns).toHaveLength(1);
    });

    it('на полном списке поле и кнопка недоступны', () => {
      act(() => {
        for (let i = 0; i < MAX_SAVED_DESIGNS; i++) theme().saveDesign(`Вид ${i}`);
      });
      render(<CustomDesignsSection />);

      expect((screen.getByTestId('settings-design-save-name') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByTestId('settings-design-save') as HTMLButtonElement).disabled).toBe(true);
    });

    it('помечает применённое оформление и не даёт переписать его собой', () => {
      act(() => theme().saveDesign('Текущее'));
      render(<CustomDesignsSection />);

      // Сохранённое только что и есть то, что на экране, — карточка это признаёт.
      expect(screen.getByTestId('settings-design-saved-apply-0').textContent).toContain('Применено');
      expect((screen.getByTestId('settings-design-saved-update-0') as HTMLButtonElement).disabled).toBe(true);

      act(() => theme().setPreset('obsidian'));

      expect(screen.getByTestId('settings-design-saved-apply-0').textContent).toContain('Применить');
      expect((screen.getByTestId('settings-design-saved-update-0') as HTMLButtonElement).disabled).toBe(false);
    });

    it('применяет и удаляет по нажатию', () => {
      pickEverything();
      act(() => theme().saveDesign('Собранное'));
      act(() => theme().resetOverrides());
      render(<CustomDesignsSection />);

      fireEvent.click(screen.getByTestId('settings-design-saved-apply-0'));
      expect(theme().overrides.radius).toBe('pill');

      fireEvent.click(screen.getByTestId('settings-design-saved-delete-0'));
      expect(theme().savedDesigns).toEqual([]);
      expect(screen.getByTestId('settings-design-saved-empty')).toBeTruthy();
    });

    it('миниатюра показывает переменные снимка, а не текущего вида', () => {
      // Иначе шесть своих оформлений в списке выглядят одной карточкой: все они
      // показывали бы то, что уже на экране, и выбирать пришлось бы по подписи.
      act(() => {
        theme().setDepth('light');
        theme().saveDesign('Светлое');
        theme().setDepth('night');
        theme().saveDesign('Ночное');
      });
      render(<CustomDesignsSection />);

      const light = screen.getByTestId('settings-design-saved-preview-0').getAttribute('style') ?? '';
      const night = screen.getByTestId('settings-design-saved-preview-1').getAttribute('style') ?? '';

      expect(light).toContain('--bg-base');
      expect(light).not.toBe(night);
    });

    it('кнопки действий названы для чтения с экрана', () => {
      act(() => theme().saveDesign('Вечернее'));
      render(<CustomDesignsSection />);

      expect(screen.getByTestId('settings-design-saved-delete-0').getAttribute('aria-label')).toContain(
        'Вечернее'
      );
      expect(screen.getByTestId('settings-design-saved-update-0').getAttribute('aria-label')).toContain(
        'Вечернее'
      );
      expect(screen.getByTestId('settings-design-save-name').getAttribute('aria-label')).toBeTruthy();
    });
  });
});
