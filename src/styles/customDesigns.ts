import { ACCENT_PRESETS, DEFAULT_ACCENT_ID, DEFAULT_THEME_DEPTH, isThemeDepth, normalizeHex, THEME_DEPTHS, type ThemeDepth } from './palette';
import {
  DEFAULT_PRESET_ID,
  findPreset,
  isDensityOverride,
  isMotionOverride,
  isParticleProfileId,
  isPresetId,
  isRadiusOverride,
  NO_OVERRIDES,
  type DesignOverrides,
  type PresetId
} from './presets';
import {
  DEFAULT_FONT_WEIGHT_MODE,
  DEFAULT_LETTER_SPACING,
  DEFAULT_TYPE_SCALE,
  FONT_OPTIONS,
  isFontId,
  isFontWeightModeId,
  isLetterSpacingId,
  isTypeScaleId,
  type FontId,
  type FontWeightModeId,
  type LetterSpacingId,
  type TypeScaleId
} from './typography';

/**
 * Своё оформление — снимок всего выбора под именем.
 *
 * Зачем: готовых пресетов пять, а ручек поверх них — восемь, и собранное
 * сочетание существует ровно до следующего клика по другому пресету. Человек,
 * который полчаса подбирал «Обсидиан с пастельными углами и без зерна», терял его
 * навсегда, стоило посмотреть, как выглядит «Бумага». Снимок делает подбор
 * обратимым, и только поэтому по пресетам становится не страшно ходить.
 *
 * Снимок хранит выбор, а не посчитанные переменные. Это важнее, чем кажется:
 * лестницы поверхностей и длительностей считаются из выбора в `designVars`, и
 * если однажды поправить в них оттенок или шаг, чужие сохранённые оформления
 * поедут вместе со встроенными. Записанные переменные, наоборот, законсервировали
 * бы старую версию темы и с обновлением приложения разошлись бы с ней навсегда.
 */

/** Весь выбор оформления целиком — то же, что хранит `useThemeStore`. */
export interface DesignSnapshot {
  presetId: PresetId;
  depth: ThemeDepth;
  /** Идентификатор пресета из `ACCENT_PRESETS`. */
  accentId: string;
  /** Свой цвет в виде `#rrggbb` или `null`, если человек его не задавал. */
  customAccentHex: string | null;
  fontId: FontId;
  typeScaleId: TypeScaleId;
  fontWeightId: FontWeightModeId;
  letterSpacingId: LetterSpacingId;
  overrides: DesignOverrides;
}

export interface SavedDesign {
  id: string;
  name: string;
  snapshot: DesignSnapshot;
}

/**
 * Предел на число сохранённых. Не про память — про список: дальше двенадцати он
 * перестаёт быть набором своих оформлений и становится свалкой, в которой ищут
 * глазами. Упереться в предел лучше, чем однажды пролистывать сорок карточек.
 */
export const MAX_SAVED_DESIGNS = 12;

/** Предел длины имени: длиннее не влезает в карточку и обрезается многоточием. */
export const MAX_DESIGN_NAME = 32;

/**
 * Имя, годное для сохранения, или `null`.
 *
 * Пробелы по краям срезаются до проверки: имя из одних пробелов выглядит в списке
 * как пустая карточка, которую нельзя ни назвать, ни узнать.
 */
export function normalizeDesignName(input: string): string | null {
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_DESIGN_NAME);
}

/**
 * Разбор одного снимка. Каждое поле проверяется отдельно и в одиночку падает до
 * значения по умолчанию: испорченная гарнитура не должна отменять подобранные
 * углы, плотность и цвет — иначе одна битая строка в базе стирает всю работу.
 */
export function parseSnapshot(raw: unknown): DesignSnapshot {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const presetId = isPresetId(source.presetId) ? source.presetId : DEFAULT_PRESET_ID;

  return {
    presetId,
    depth: isThemeDepth(source.depth) ? source.depth : DEFAULT_THEME_DEPTH,
    accentId:
      typeof source.accentId === 'string' && ACCENT_PRESETS.some((preset) => preset.id === source.accentId)
        ? source.accentId
        : DEFAULT_ACCENT_ID,
    customAccentHex: typeof source.customAccentHex === 'string' ? normalizeHex(source.customAccentHex) : null,
    fontId: isFontId(source.fontId) ? source.fontId : findPreset(presetId).fontId,
    typeScaleId: isTypeScaleId(source.typeScaleId) ? source.typeScaleId : DEFAULT_TYPE_SCALE,
    fontWeightId: isFontWeightModeId(source.fontWeightId) ? source.fontWeightId : DEFAULT_FONT_WEIGHT_MODE,
    letterSpacingId: isLetterSpacingId(source.letterSpacingId) ? source.letterSpacingId : DEFAULT_LETTER_SPACING,
    overrides: parseOverrides(source.overrides)
  };
}

/**
 * Разбор ручек. `null` означает «как в пресете», поэтому неизвестное значение
 * возвращается именно нулём, а не первым из допустимых: так оформление
 * продолжает следовать за пресетом, вместо того чтобы получить чужую ручку.
 */
export function parseOverrides(raw: unknown): DesignOverrides {
  if (!raw || typeof raw !== 'object') return NO_OVERRIDES;
  const source = raw as Record<string, unknown>;
  return {
    radius: isRadiusOverride(source.radius) ? source.radius : null,
    density: isDensityOverride(source.density) ? source.density : null,
    motion: isMotionOverride(source.motion) ? source.motion : null,
    particles: isParticleProfileId(source.particles) ? source.particles : null,
    glass: typeof source.glass === 'boolean' ? source.glass : null,
    grain: typeof source.grain === 'boolean' ? source.grain : null
  };
}

/**
 * Разбор всего списка из базы.
 *
 * Записи без имени или без идентификатора выбрасываются целиком: карточку без
 * имени нельзя ни выбрать, ни удалить — она бы висела в списке навсегда. Всё
 * остальное чинится по месту в `parseSnapshot`, а не отбрасывается.
 */
export function parseSavedDesigns(raw: unknown): SavedDesign[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: SavedDesign[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as Record<string, unknown>;
    if (typeof source.id !== 'string' || !source.id) continue;
    if (typeof source.name !== 'string') continue;
    const name = normalizeDesignName(source.name);
    if (!name) continue;
    // Совпавшие идентификаторы — это две карточки, которые удаляются вместе:
    // удаление ищет по идентификатору и снесло бы обе.
    if (seen.has(source.id)) continue;
    seen.add(source.id);

    result.push({ id: source.id, name, snapshot: parseSnapshot(source.snapshot) });
    if (result.length >= MAX_SAVED_DESIGNS) break;
  }

  return result;
}

/**
 * Счётчик в модуле, а не время в идентификаторе: два сохранения подряд попадают в
 * одну миллисекунду, и список получил бы два неразличимых ключа.
 */
let sequence = 0;

export function nextDesignId(): string {
  sequence += 1;
  return `design-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Снимок текущего выбора — ровно те поля, что попадут в базу. */
export function snapshotOf(state: DesignSnapshot): DesignSnapshot {
  return {
    presetId: state.presetId,
    depth: state.depth,
    accentId: state.accentId,
    customAccentHex: state.customAccentHex,
    fontId: state.fontId,
    typeScaleId: state.typeScaleId,
    fontWeightId: state.fontWeightId,
    letterSpacingId: state.letterSpacingId,
    overrides: { ...state.overrides }
  };
}

/**
 * Совпадают ли два снимка.
 *
 * Нужно для подсветки «сейчас применено это»: без неё в списке из шести своих
 * оформлений нельзя понять, какое из них на экране, и человек тыкает по всем
 * подряд, чтобы найти то, в котором уже находится.
 */
export function snapshotsEqual(a: DesignSnapshot, b: DesignSnapshot): boolean {
  return (
    a.presetId === b.presetId &&
    a.depth === b.depth &&
    a.accentId === b.accentId &&
    a.customAccentHex === b.customAccentHex &&
    a.fontId === b.fontId &&
    a.typeScaleId === b.typeScaleId &&
    a.fontWeightId === b.fontWeightId &&
    a.letterSpacingId === b.letterSpacingId &&
    a.overrides.radius === b.overrides.radius &&
    a.overrides.density === b.overrides.density &&
    a.overrides.motion === b.overrides.motion &&
    a.overrides.particles === b.overrides.particles &&
    a.overrides.glass === b.overrides.glass &&
    a.overrides.grain === b.overrides.grain
  );
}

const RADIUS_WORDS: Record<string, string> = {
  sharp: 'острые углы',
  soft: 'мягкие углы',
  round: 'круглые углы',
  pill: 'пилюли'
};

const DENSITY_WORDS: Record<string, string> = {
  tight: 'плотно',
  normal: 'обычно',
  airy: 'просторно'
};

const MOTION_WORDS: Record<string, string> = {
  instant: 'без движения',
  fast: 'быстро',
  normal: 'обычная скорость',
  slow: 'медленно'
};

/**
 * Подпись под карточкой — из чего это оформление собрано.
 *
 * Перечисляются пресет, светлота и гарнитура, а из ручек — только тронутые.
 * Полный список всех восьми ручек занял бы три строки и в нём потерялось бы
 * единственное отличие от пресета, ради которого снимок и сохраняли.
 */
export function describeSnapshot(snapshot: DesignSnapshot): string {
  const parts: string[] = [
    findPreset(snapshot.presetId).label,
    THEME_DEPTHS.find((option) => option.id === snapshot.depth)?.label ?? snapshot.depth,
    FONT_OPTIONS.find((option) => option.id === snapshot.fontId)?.label ?? snapshot.fontId
  ];

  const { radius, density, motion, particles, glass, grain } = snapshot.overrides;
  if (radius) parts.push(RADIUS_WORDS[radius] ?? radius);
  if (density) parts.push(DENSITY_WORDS[density] ?? density);
  if (motion) parts.push(MOTION_WORDS[motion] ?? motion);
  if (particles) parts.push(particles === 'off' ? 'без частиц' : 'частицы');
  if (glass === false) parts.push('без стекла');
  if (grain === false) parts.push('без зерна');

  return parts.join(' · ');
}
