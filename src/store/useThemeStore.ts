import { create } from 'zustand';
import { usePlayerLayoutStore } from './usePlayerLayoutStore';
import { DEFAULT_PLAYER_SKIN_ID } from '../styles/playerSkins';
import * as dbService from '../services/db';
import { applyDesign, applyParticles } from '../services/designService';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HEX,
  DEFAULT_ACCENT_ID,
  DEFAULT_THEME_DEPTH,
  isThemeDepth,
  normalizeHex,
  type ThemeDepth
} from '../styles/palette';
import {
  DEFAULT_PRESET_ID,
  findPreset,
  isPresetId,
  NO_OVERRIDES,
  resolveParticles,
  type DesignOverrides,
  type PresetId
} from '../styles/presets';
import {
  MAX_SAVED_DESIGNS,
  nextDesignId,
  normalizeDesignName,
  parseOverrides,
  parseSavedDesigns,
  snapshotOf,
  type DesignSnapshot,
  type SavedDesign
} from '../styles/customDesigns';
import {
  DEFAULT_FONT_ID,
  DEFAULT_FONT_WEIGHT_MODE,
  DEFAULT_LETTER_SPACING,
  DEFAULT_TYPE_SCALE,
  isFontId,
  isFontWeightModeId,
  isLetterSpacingId,
  isTypeScaleId,
  type FontId,
  type FontWeightModeId,
  type LetterSpacingId,
  type TypeScaleId,
  type TypographySelection
} from '../styles/typography';

/**
 * Весь выбор оформления в одном хранилище.
 *
 * Почему в одном, а не в трёх по смыслу (цвет, пресет, шрифт). Применяются они
 * одним заходом и неразделимо: пресет задаёт лестницу поверхностей, глубина —
 * светлоту, акцент в светлой теме приводится к читаемому, а гарнитура влияет на
 * то, какие кегли выглядят уместно. Три хранилища означали бы либо кадры с
 * несогласованным набором переменных, либо круговые импорты — каждое тянулось бы
 * за состоянием двух других, чтобы собрать полную картину для применения.
 *
 * Отдельно от плеера — потому что настройки вида не связаны с воспроизведением ни
 * данными, ни временем жизни, а подписка на плеер ради цвета заставляла бы
 * перерисовываться на каждом тике прогресса.
 *
 * Ручки (`overrides`) хранят `null` там, где человек ничего не менял, и это не
 * лень: `null` означает «как в пресете», поэтому смена пресета сразу видна во
 * всём, что не трогали руками. Записанное значение, наоборот, переживает смену
 * пресета — иначе выбор человека молча отменялся бы.
 */

/** Ключи для `db.setSetting` / `db.getSetting`. Уходят в базу — переименованию не подлежат. */
export const THEME_SETTING_KEYS = {
  accentId: 'themeAccentId',
  customAccentHex: 'themeCustomAccentHex',
  depth: 'themeDepth',
  preset: 'designPreset',
  fontId: 'designFontId',
  typeScale: 'designTypeScale',
  fontWeight: 'designFontWeight',
  letterSpacing: 'designLetterSpacing',
  overrides: 'designOverrides',
  savedDesigns: 'designSavedList'
} as const;

/**
 * Состояние — это и есть снимок оформления, поэтому тип один на двоих.
 *
 * Раньше поля были перечислены здесь второй раз, и сохранение своих оформлений
 * молча теряло бы каждую новую настройку: добавили ручку в состояние — снимок о
 * ней не знает и «своё оформление» возвращает её к значению по умолчанию.
 */
export type ThemeStoreState = DesignSnapshot;

export interface ThemeStore extends ThemeStoreState {
  /** Свои оформления в порядке сохранения — новое встаёт в конец списка. */
  savedDesigns: SavedDesign[];
  setAccent: (id: string) => void;
  setCustomAccent: (hex: string) => void;
  setDepth: (depth: ThemeDepth) => void;
  /** Пресет подтягивает свою гарнитуру и, если требует, свою глубину. */
  setPreset: (id: PresetId) => void;
  setFont: (id: FontId) => void;
  setTypeScale: (id: TypeScaleId) => void;
  setFontWeight: (id: FontWeightModeId) => void;
  setLetterSpacing: (id: LetterSpacingId) => void;
  /** Одна ручка за раз; `null` возвращает её к значению пресета. */
  setOverride: <K extends keyof DesignOverrides>(key: K, value: DesignOverrides[K]) => void;
  /** Сбрасывает все ручки, оставляя пресет, цвет и шрифт. */
  resetOverrides: () => void;
  /**
   * Сохранить текущий вид под именем. Пустое имя и переполненный список ничего
   * не делают — кнопка в настройках в этих случаях недоступна.
   */
  saveDesign: (name: string) => void;
  /** Применить сохранённое целиком: пресет, цвет, шрифт и все ручки разом. */
  applySavedDesign: (id: string) => void;
  /** Переписать снимок сохранённого текущим видом, имя оставить. */
  updateSavedDesign: (id: string) => void;
  deleteSavedDesign: (id: string) => void;
  hydrateTheme: () => Promise<void>;
}

/** Сохранение настройки никогда не должно доходить до интерфейса ошибкой. */
function persistSetting(key: string, value: unknown): void {
  try {
    const result = dbService.setSetting(key, value);
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        console.warn(`[useThemeStore] Could not persist "${key}":`, err);
      });
    }
  } catch (err) {
    console.warn(`[useThemeStore] Could not persist "${key}":`, err);
  }
}

function presetHex(id: string): string | null {
  return ACCENT_PRESETS.find((preset) => preset.id === id)?.hex ?? null;
}

/**
 * Цвет, который реально уходит в CSS.
 *
 * Одно место на всё приложение: и применение, и подсветка активного образца в
 * настройках спрашивают здесь, поэтому кнопка не может оказаться нажатой у
 * одного цвета, а на экране быть другой.
 */
export function resolveAccentHex(state: Pick<ThemeStoreState, 'accentId' | 'customAccentHex'>): string {
  return state.customAccentHex ?? presetHex(state.accentId) ?? DEFAULT_ACCENT_HEX;
}

export function resolveTypography(state: ThemeStoreState): TypographySelection {
  return {
    fontId: state.fontId,
    scaleId: state.typeScaleId,
    weightId: state.fontWeightId,
    spacingId: state.letterSpacingId
  };
}

/**
 * Применение всего выбора целиком.
 *
 * Единственный путь к документу: каждый сеттер меняет состояние и вызывает это,
 * поэтому частичного применения не бывает по построению.
 */
function apply(state: ThemeStoreState): void {
  applyDesign({
    presetId: state.presetId,
    depth: state.depth,
    accentHex: resolveAccentHex(state),
    overrides: state.overrides,
    typography: resolveTypography(state)
  });
  applyParticles(resolveParticles(state));
}

const INITIAL: ThemeStoreState = {
  accentId: DEFAULT_ACCENT_ID,
  customAccentHex: null,
  depth: DEFAULT_THEME_DEPTH,
  presetId: DEFAULT_PRESET_ID,
  fontId: DEFAULT_FONT_ID,
  typeScaleId: DEFAULT_TYPE_SCALE,
  fontWeightId: DEFAULT_FONT_WEIGHT_MODE,
  letterSpacingId: DEFAULT_LETTER_SPACING,
  overrides: NO_OVERRIDES
};

/**
 * Восстановление идёт один раз за сеанс, но вызвать его могут дважды: обычное
 * окно и повторный монтаж в разработке. Обещание в модуле, а не флаг в
 * состоянии, — второй вызов просто дожидается первого, а не читает базу заново.
 */
let hydrationPromise: Promise<void> | null = null;

export const useThemeStore = create<ThemeStore>((set, get) => {
  /** Записать изменение, применить его и сохранить — в этом порядке. */
  const commit = (patch: Partial<ThemeStoreState>, persist: [string, unknown][]): void => {
    set(patch);
    apply(get());
    for (const [key, value] of persist) persistSetting(key, value);
  };

  return {
    ...INITIAL,
    savedDesigns: [],

    setAccent: (id: string) => {
      const hex = presetHex(id);
      // Неизвестный пресет — это опечатка в коде или мусор из базы. Молча взять
      // цвет по умолчанию хуже, чем не менять ничего: выбор человека остался бы
      // подменённым без объяснения.
      if (!hex) return;

      commit({ accentId: id, customAccentHex: null }, [
        [THEME_SETTING_KEYS.accentId, id],
        [THEME_SETTING_KEYS.customAccentHex, null]
      ]);
    },

    setCustomAccent: (hex: string) => {
      const normalized = normalizeHex(hex);
      // Поле ввода вызывает это на каждый символ, и половина `#8fc` — не цвет.
      // Незаконченный ввод оставляет тему как есть, а не гасит акцент.
      if (!normalized) return;

      commit({ customAccentHex: normalized }, [[THEME_SETTING_KEYS.customAccentHex, normalized]]);
    },

    setDepth: (depth: ThemeDepth) => {
      if (!isThemeDepth(depth)) return;
      commit({ depth }, [[THEME_SETTING_KEYS.depth, depth]]);
    },

    setPreset: (id: PresetId) => {
      if (!isPresetId(id)) return;

      const preset = findPreset(id);
      const current = get();
      // Пресет задуман с определённой гарнитурой, но если человек уже выбирал
      // шрифт сам, его выбор старше: молча подменить шрифт — значит отменить
      // осознанное решение. Признак «выбирал сам» — отличие от гарнитуры
      // прежнего пресета.
      const keepFont = current.fontId !== findPreset(current.presetId).fontId;
      const fontId = keepFont ? current.fontId : preset.fontId;

      /*
       * Требование пресета к глубине здесь не записывается.
       *
       * «Бумага» на почти чёрной базе не бумага, и глубину она действительно
       * держит — но делает это `resolveDepth` в момент применения. Раньше значение
       * писалось ещё и в состояние, и выбор человека затирался: «Сумерки» → взял
       * «Бумагу» → вернулся к «Острову» — и остался в светлой теме, которой у
       * «Острова» никогда не просил.
       *
       * Теперь `depth` — это память о выборе, а не то, что на экране. Что на
       * экране, считает `resolveDepth`, и настройки показывают именно его.
       */
      /*
       * Облик полосы плеера — по тому же правилу, что и гарнитура.
       *
       * «Дымка» без стеклянной полосы теряет половину смысла: полоса — самая
       * большая поверхность в окне, и просвечивать должна в первую очередь она.
       * Но если человек уже выбирал облик сам, его выбор старше — признак тот
       * же, что у шрифта: отличие от облика прежнего пресета.
       */
      if (preset.playerSkinId) {
        const layout = usePlayerLayoutStore.getState();
        const previousSkin = findPreset(current.presetId).playerSkinId;
        const chosenByHand = layout.skinId !== (previousSkin ?? DEFAULT_PLAYER_SKIN_ID);
        if (!chosenByHand) layout.setPlayerSkin(preset.playerSkinId);
      }

      commit({ presetId: id, fontId }, [
        [THEME_SETTING_KEYS.preset, id],
        [THEME_SETTING_KEYS.fontId, fontId]
      ]);
    },

    setFont: (id: FontId) => {
      if (!isFontId(id)) return;
      commit({ fontId: id }, [[THEME_SETTING_KEYS.fontId, id]]);
    },

    setTypeScale: (id: TypeScaleId) => {
      if (!isTypeScaleId(id)) return;
      commit({ typeScaleId: id }, [[THEME_SETTING_KEYS.typeScale, id]]);
    },

    setFontWeight: (id: FontWeightModeId) => {
      if (!isFontWeightModeId(id)) return;
      commit({ fontWeightId: id }, [[THEME_SETTING_KEYS.fontWeight, id]]);
    },

    setLetterSpacing: (id: LetterSpacingId) => {
      if (!isLetterSpacingId(id)) return;
      commit({ letterSpacingId: id }, [[THEME_SETTING_KEYS.letterSpacing, id]]);
    },

    setOverride: (key, value) => {
      const overrides = { ...get().overrides, [key]: value };
      commit({ overrides }, [[THEME_SETTING_KEYS.overrides, overrides]]);
    },

    resetOverrides: () => {
      commit({ overrides: NO_OVERRIDES }, [[THEME_SETTING_KEYS.overrides, NO_OVERRIDES]]);
    },

    saveDesign: (name: string) => {
      const clean = normalizeDesignName(name);
      // Пустое имя и упёршийся в предел список — не ошибка, а состояние кнопки:
      // в настройках она в этих случаях недоступна, и молчание здесь совпадает с
      // тем, что человек видит на экране.
      if (!clean) return;

      const current = get();
      if (current.savedDesigns.length >= MAX_SAVED_DESIGNS) return;

      const savedDesigns = [...current.savedDesigns, { id: nextDesignId(), name: clean, snapshot: snapshotOf(current) }];
      set({ savedDesigns });
      persistSetting(THEME_SETTING_KEYS.savedDesigns, savedDesigns);
    },

    applySavedDesign: (id: string) => {
      const saved = get().savedDesigns.find((design) => design.id === id);
      if (!saved) return;

      // Сохраняется каждое поле по отдельности, а не список целиком: ключи в базе
      // те же, что у обычных настроек, поэтому применённое своё оформление
      // переживает перезапуск даже если список своих оформлений потерялся.
      const next = snapshotOf(saved.snapshot);
      commit(next, [
        [THEME_SETTING_KEYS.preset, next.presetId],
        [THEME_SETTING_KEYS.depth, next.depth],
        [THEME_SETTING_KEYS.accentId, next.accentId],
        [THEME_SETTING_KEYS.customAccentHex, next.customAccentHex],
        [THEME_SETTING_KEYS.fontId, next.fontId],
        [THEME_SETTING_KEYS.typeScale, next.typeScaleId],
        [THEME_SETTING_KEYS.fontWeight, next.fontWeightId],
        [THEME_SETTING_KEYS.letterSpacing, next.letterSpacingId],
        [THEME_SETTING_KEYS.overrides, next.overrides]
      ]);
    },

    updateSavedDesign: (id: string) => {
      const current = get();
      if (!current.savedDesigns.some((design) => design.id === id)) return;

      const savedDesigns = current.savedDesigns.map((design) =>
        design.id === id ? { ...design, snapshot: snapshotOf(current) } : design
      );
      set({ savedDesigns });
      persistSetting(THEME_SETTING_KEYS.savedDesigns, savedDesigns);
    },

    deleteSavedDesign: (id: string) => {
      const savedDesigns = get().savedDesigns.filter((design) => design.id !== id);
      set({ savedDesigns });
      persistSetting(THEME_SETTING_KEYS.savedDesigns, savedDesigns);
    },

    hydrateTheme: async () => {
      if (hydrationPromise) return hydrationPromise;

      hydrationPromise = (async () => {
        const current = get();
        try {
          const [
            storedAccentId,
            storedCustomHex,
            storedDepth,
            storedPreset,
            storedFont,
            storedScale,
            storedWeight,
            storedSpacing,
            storedOverrides,
            storedSaved
          ] = await Promise.all([
            dbService.getSetting<string>(THEME_SETTING_KEYS.accentId, current.accentId),
            dbService.getSetting<string | null>(THEME_SETTING_KEYS.customAccentHex, current.customAccentHex),
            dbService.getSetting<ThemeDepth>(THEME_SETTING_KEYS.depth, current.depth),
            dbService.getSetting<PresetId>(THEME_SETTING_KEYS.preset, current.presetId),
            dbService.getSetting<FontId>(THEME_SETTING_KEYS.fontId, current.fontId),
            dbService.getSetting<TypeScaleId>(THEME_SETTING_KEYS.typeScale, current.typeScaleId),
            dbService.getSetting<FontWeightModeId>(THEME_SETTING_KEYS.fontWeight, current.fontWeightId),
            dbService.getSetting<LetterSpacingId>(THEME_SETTING_KEYS.letterSpacing, current.letterSpacingId),
            dbService.getSetting<unknown>(THEME_SETTING_KEYS.overrides, null),
            dbService.getSetting<unknown>(THEME_SETTING_KEYS.savedDesigns, null)
          ]);

          // Каждое значение проверяется отдельно: пропавший пресет или битый hex
          // не должны отменять все остальные настройки.
          const presetId = isPresetId(storedPreset) ? storedPreset : DEFAULT_PRESET_ID;
          const next: ThemeStoreState = {
            accentId: presetHex(storedAccentId) ? storedAccentId : DEFAULT_ACCENT_ID,
            customAccentHex: typeof storedCustomHex === 'string' ? normalizeHex(storedCustomHex) : null,
            depth: isThemeDepth(storedDepth) ? storedDepth : DEFAULT_THEME_DEPTH,
            presetId,
            fontId: isFontId(storedFont) ? storedFont : findPreset(presetId).fontId,
            typeScaleId: isTypeScaleId(storedScale) ? storedScale : DEFAULT_TYPE_SCALE,
            fontWeightId: isFontWeightModeId(storedWeight) ? storedWeight : DEFAULT_FONT_WEIGHT_MODE,
            letterSpacingId: isLetterSpacingId(storedSpacing) ? storedSpacing : DEFAULT_LETTER_SPACING,
            overrides: parseOverrides(storedOverrides)
          };

          set(next);
          apply(next);
          // Список своих оформлений применять некуда — он только пополняет
          // настройки, поэтому ставится отдельно от снимка и на вид не влияет.
          set({ savedDesigns: parseSavedDesigns(storedSaved) });
        } catch (err) {
          console.warn('[useThemeStore] Could not hydrate theme settings:', err);
          // База недоступна — оформление всё равно должно быть применённым, иначе
          // окно останется с голым `:root` и без атрибутов пресета.
          apply(current);
        } finally {
          hydrationPromise = null;
        }
      })();

      return hydrationPromise;
    }
  };
});
