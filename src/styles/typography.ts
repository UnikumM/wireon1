/**
 * Типографика как настройка, а не как константа.
 *
 * Раньше шрифт был вписан в таблицу стилей одной строкой, и поменять его человек
 * не мог никак. Теперь гарнитура, кегль, насыщенность и межбуквенное расстояние —
 * четыре независимых выбора, а этот модуль превращает их в готовый набор
 * CSS-переменных.
 *
 * Почему шкала считается, а не лежит таблицей. Кегль настраивается множителем, и
 * при семи ступенях размера с межстрочным и межбуквенным на каждую это сорок
 * значений: держать их руками для четырёх шкал — сорок мест, где можно ошибиться.
 * Здесь ступени заданы один раз, а множитель применяется к ним арифметически.
 *
 * Почему межстрочное не масштабируется. Оно безразмерное (кратное кеглю), и
 * умножать его на тот же множитель значит растить пробел между строками дважды —
 * сначала через кегль, потом через кратность.
 *
 * Гарнитуры подключаются статическими импортами в `src/main.tsx`: динамический
 * `import()` шрифта дал бы вспышку системным шрифтом при каждом переключении, а
 * в собранном приложении файлы всё равно лежат локально и ничего не стоят.
 */

/** Идентификаторы гарнитур. Уходят в базу, поэтому переименовывать нельзя. */
export type FontId = 'onest' | 'golos' | 'manrope' | 'tight' | 'unbounded' | 'system';

export interface FontOption {
  id: FontId;
  /** Название для настроек — так, как его пишет сам производитель шрифта. */
  label: string;
  /** Короткое пояснение: по одному образцу гарнитуры не выбирают. */
  description: string;
  /**
   * Готовый стек. Первым — семейство из fontsource, дальше системные подпорки:
   * файл шрифта может не успеть загрузиться, и первый кадр рисуется чем-то.
   */
  stack: string;
}

/**
 * Системные подпорки одни для всех гарнитур: если своё семейство не приехало,
 * подменять его должен привычный интерфейсный шрифт, а не случайный засечный.
 */
const SYSTEM_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: 'onest',
    label: 'Onest',
    description: 'Геометрический гротеск, ровная кириллица — вид по умолчанию',
    stack: `'Onest Variable', 'Onest', ${SYSTEM_STACK}`
  },
  {
    id: 'golos',
    label: 'Golos Text',
    description: 'Русский текстовый гротеск: спокойный, для долгого чтения',
    stack: `'Golos Text Variable', 'Golos Text', ${SYSTEM_STACK}`
  },
  {
    id: 'manrope',
    label: 'Manrope',
    description: 'Округлые формы, мягкий и дружелюбный',
    stack: `'Manrope Variable', 'Manrope', ${SYSTEM_STACK}`
  },
  {
    id: 'tight',
    label: 'Inter Tight',
    description: 'Плотный и узкий — в списки влезает больше',
    stack: `'Inter Tight Variable', 'Inter Tight', ${SYSTEM_STACK}`
  },
  {
    id: 'unbounded',
    label: 'Unbounded',
    // Было «заголовки кричат, мелкий текст страдает». Соседние подписи в этом
    // списке говорят про начертание, а не про переживания текста.
    description: 'Широкий дисплейный: хорош в заголовках, мелким читается хуже',
    stack: `'Unbounded Variable', 'Unbounded', ${SYSTEM_STACK}`
  },
  {
    id: 'system',
    label: 'Системный',
    description: 'Шрифт самой Windows — ничего не подгружается',
    stack: SYSTEM_STACK
  }
] as const;

export const DEFAULT_FONT_ID: FontId = 'onest';

/**
 * Моноширинный не выбирается: он нужен ровно в двух местах — счётчики времени и
 * диагностика, — и там важна не гарнитура, а то, что цифры не пляшут по ширине.
 */
export const MONO_STACK = "'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

export function isFontId(value: unknown): value is FontId {
  return typeof value === 'string' && FONT_OPTIONS.some((font) => font.id === value);
}

export function fontStack(id: FontId): string {
  return FONT_OPTIONS.find((font) => font.id === id)?.stack ?? FONT_OPTIONS[0].stack;
}

/* ==========================================================================
   Кегль
   ========================================================================== */

export type TypeScaleId = 'compact' | 'normal' | 'cozy' | 'large';

export interface TypeScaleOption {
  id: TypeScaleId;
  label: string;
  /** Множитель кегля. Ниже 0.9 мелкий текст перестаёт читаться на 1080p. */
  factor: number;
}

export const TYPE_SCALES: readonly TypeScaleOption[] = [
  { id: 'compact', label: 'Мелкий', factor: 0.92 },
  { id: 'normal', label: 'Обычный', factor: 1 },
  { id: 'cozy', label: 'Крупнее', factor: 1.08 },
  { id: 'large', label: 'Крупный', factor: 1.18 }
] as const;

export const DEFAULT_TYPE_SCALE: TypeScaleId = 'normal';

export function isTypeScaleId(value: unknown): value is TypeScaleId {
  return typeof value === 'string' && TYPE_SCALES.some((scale) => scale.id === value);
}

/** Названия ступеней в том порядке, в каком они растут. */
const STEP_NAMES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'] as const;
type StepName = (typeof STEP_NAMES)[number];

interface Step {
  /** Кегль в пикселях при множителе 1. */
  size: number;
  /** Межстрочное как кратность кегля: с ростом кегля строка поджимается. */
  leading: number;
  /** Межбуквенное в em при обычной плотности. */
  tracking: number;
}

/**
 * Ступени шкалы. Тройками, а не тремя отдельными таблицами: размер, строка и
 * трекинг связаны — крупный текст с трекингом мелкого выглядит разреженным, а
 * мелкий без положительного трекинга слипается.
 */
const STEPS: Readonly<Record<StepName, Step>> = {
  xs: { size: 11, leading: 1.45, tracking: 0.012 },
  sm: { size: 13, leading: 1.5, tracking: 0.004 },
  base: { size: 14.5, leading: 1.55, tracking: 0 },
  lg: { size: 17, leading: 1.4, tracking: -0.008 },
  xl: { size: 22, leading: 1.28, tracking: -0.016 },
  '2xl': { size: 29, leading: 1.18, tracking: -0.022 },
  '3xl': { size: 38, leading: 1.08, tracking: -0.03 }
};

/* ==========================================================================
   Насыщенность и плотность букв
   ========================================================================== */

export type FontWeightModeId = 'light' | 'normal' | 'bold';

export interface FontWeightModeOption {
  id: FontWeightModeId;
  label: string;
  /**
   * Сдвиг всех четырёх ступеней насыщенности. Переменные шрифты тянутся
   * непрерывно, поэтому сдвиг работает как регулятор, а не как выбор из двух
   * начертаний.
   */
  shift: number;
}

export const FONT_WEIGHT_MODES: readonly FontWeightModeOption[] = [
  { id: 'light', label: 'Тонкий', shift: -50 },
  { id: 'normal', label: 'Обычный', shift: 0 },
  { id: 'bold', label: 'Жирный', shift: 100 }
] as const;

export const DEFAULT_FONT_WEIGHT_MODE: FontWeightModeId = 'normal';

export function isFontWeightModeId(value: unknown): value is FontWeightModeId {
  return typeof value === 'string' && FONT_WEIGHT_MODES.some((mode) => mode.id === value);
}

export type LetterSpacingId = 'tight' | 'normal' | 'wide';

export interface LetterSpacingOption {
  id: LetterSpacingId;
  label: string;
  /** Добавка к трекингу каждой ступени, в em. */
  offset: number;
}

export const LETTER_SPACINGS: readonly LetterSpacingOption[] = [
  { id: 'tight', label: 'Плотно', offset: -0.008 },
  { id: 'normal', label: 'Обычно', offset: 0 },
  { id: 'wide', label: 'Просторно', offset: 0.012 }
] as const;

export const DEFAULT_LETTER_SPACING: LetterSpacingId = 'normal';

export function isLetterSpacingId(value: unknown): value is LetterSpacingId {
  return typeof value === 'string' && LETTER_SPACINGS.some((item) => item.id === value);
}

/* ==========================================================================
   Сборка переменных
   ========================================================================== */

export interface TypographySelection {
  fontId: FontId;
  scaleId: TypeScaleId;
  weightId: FontWeightModeId;
  spacingId: LetterSpacingId;
}

export const DEFAULT_TYPOGRAPHY: TypographySelection = {
  fontId: DEFAULT_FONT_ID,
  scaleId: DEFAULT_TYPE_SCALE,
  weightId: DEFAULT_FONT_WEIGHT_MODE,
  spacingId: DEFAULT_LETTER_SPACING
};

/** Базовые ступени насыщенности до сдвига. */
const WEIGHTS = { normal: 400, medium: 500, semibold: 600, bold: 700 } as const;

/**
 * Насыщенность за пределами 100…900 переменный шрифт не рисует — он молча
 * зажимает значение, и две соседние ступени становятся одинаковыми. Зажимаем
 * сами и в более узком коридоре: 200 снизу, чтобы обычный текст не превращался в
 * волосок, и 900 сверху.
 */
function clampWeight(value: number): number {
  return Math.min(900, Math.max(200, value));
}

/**
 * Полный набор переменных типографики.
 *
 * Возвращает карту «имя переменной → значение», а не пишет в документ: применение
 * — дело `designService`, а такую карту можно проверить тестом без окна.
 */
/**
 * Как меняется шкала на телефоне — по ступеням, а не одним числом.
 *
 * Одинаковый множитель на всю лестницу был ошибкой, и видно её сразу. Жалоба
 * была из двух половин: «то маленькое, то не вмещается». Подняв всё на 15%, я
 * починил первую и усугубил вторую: заголовок раздела стал 34 px и вытолкнул
 * подпись рядом с собой за край экрана.
 *
 * Мелкие ступени и крупные страдают от узкого экрана по-разному. Подпись в
 * 11 px нечитаема — её надо растить. Заголовок в 38 px нарисован для окна, где
 * рядом ещё половина экрана, — на 375 px он занимает треть ширины одним словом,
 * и его надо **уменьшать**.
 *
 * Числа подобраны так, чтобы основной текст попал в 16–17 px (диапазон Spotify
 * и системных приложений Android), а самый крупный заголовок влезал в строку
 * на 320 px.
 */
export const NARROW_TYPE_ADJUST: Readonly<Record<string, number>> = {
  xs: 1.15,
  sm: 1.15,
  base: 1.15,
  lg: 1.09,
  xl: 1,
  '2xl': 0.9,
  '3xl': 0.8
};

/** Совместимость: множитель по умолчанию для ступеней вне таблицы. */
export const NARROW_TYPE_FACTOR = 1.15;

export function typographyVars(
  selection: TypographySelection,
  narrow: boolean = false
): Record<string, string> {
  const scale = TYPE_SCALES.find((item) => item.id === selection.scaleId) ?? TYPE_SCALES[1];
  const weight = FONT_WEIGHT_MODES.find((item) => item.id === selection.weightId) ?? FONT_WEIGHT_MODES[1];
  const spacing = LETTER_SPACINGS.find((item) => item.id === selection.spacingId) ?? LETTER_SPACINGS[1];

  const vars: Record<string, string> = {
    '--font-sans': fontStack(selection.fontId),
    '--font-mono': MONO_STACK,
    /**
     * Дисплейное семейство отдельно от основного: логотип и крупные заголовки
     * набираются широким шрифтом, но заставлять им же читать списки нельзя. Если
     * человек уже выбрал Unbounded, второй раз подставлять его незачем.
     */
    '--font-display':
      selection.fontId === 'unbounded' ? fontStack('unbounded') : `'Unbounded Variable', ${fontStack(selection.fontId)}`,
    '--weight-normal': String(clampWeight(WEIGHTS.normal + weight.shift)),
    '--weight-medium': String(clampWeight(WEIGHTS.medium + weight.shift)),
    '--weight-semibold': String(clampWeight(WEIGHTS.semibold + weight.shift)),
    '--weight-bold': String(clampWeight(WEIGHTS.bold + weight.shift))
  };

  for (const name of STEP_NAMES) {
    const step = STEPS[name];
    // Полпикселя — предел, ниже которого разница между ступенями пропадает:
    // округление до целого схлопнуло бы 13 и 13.4 в одно значение.
    // Поправка экрана входит ДО округления: вся выкладка ниже держит
    // `кегль × кратность` целым числом пикселей, и умножать после неё значило
    // бы вернуть дробные высоты строк, из-за которых кнопки получались в 27.5
    // и 36.15 px.
    const viewportFactor = narrow ? (NARROW_TYPE_ADJUST[name] ?? NARROW_TYPE_FACTOR) : 1;
    const size = Math.round(step.size * scale.factor * viewportFactor * 2) / 2;
    vars[`--text-${name}`] = `${size}px`;
    /*
     * Кратность подгоняется под кегль так, чтобы `кегль × кратность` давало целое
     * число пикселей. Взятая как есть, она давала дробную высоту строки — база
     * 14.5 × 1.55 = 22.475 px, — а высота строки задаёт высоту всего, что обёрнуто
     * вокруг текста. Отсюда кнопки в 27.5 и 36.15 px: элемент на дробной границе
     * округляется браузером в разные стороны у разных краёв, из-за чего рамка с
     * одной стороны получается тоньше, а текст внутри слегка размыт. Разница со
     * задуманной кратностью — меньше полупикселя, ритм строк сохраняется, но
     * каждая текстовая коробка теперь встаёт на целый пиксель. Величина остаётся
     * безразмерной: правила по всему приложению кладут её прямо в `line-height`.
     */
    const leading = Math.round(size * step.leading) / size;
    // Шести знаков хватает: остаточная погрешность на порядок меньше 1/64 px, к
    // которым браузер и без того притягивает раскладку.
    vars[`--leading-${name}`] = leading.toFixed(6);
    // Трекинг у крупных ступеней отрицательный, добавка «просторно» его гасит —
    // так и задумано: разреженный заголовок читается хуже разреженной подписи.
    vars[`--tracking-${name}`] = `${(step.tracking + spacing.offset).toFixed(4)}em`;
  }

  return vars;
}
