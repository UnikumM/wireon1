/**
 * Цвет как вычисление, а не как таблица.
 *
 * Пользователь может выбрать свой акцент пипеткой, поэтому оттенки состояний
 * нельзя держать списком: под произвольный `#7fb3ff` никто заранее не подберёт
 * ни цвет наведения, ни цвет нажатия, ни подложку, ни цвет текста на кнопке.
 * Всё это выводится из одного значения здесь, а в CSS уезжает уже готовым
 * набором переменных.
 *
 * Функции чистые и без обращений к DOM — так их можно проверить тестом без
 * рендера и вызвать из главного процесса, если понадобится.
 */

/** Цвет в HSL; тон в градусах, насыщенность и светлота в процентах. */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Полный набор оттенков одного акцента — ровно то, что уходит в CSS. */
export interface AccentShades {
  accent: string;
  accentHover: string;
  accentActive: string;
  /** Подложка выбранного состояния: тот же тон, но прозрачный. */
  accentSoft: string;
  /** Рамка акцентного элемента: тот же тон, прозрачность выше подложки. */
  borderAccent: string;
  /** Обводка фокуса. */
  ringColor: string;
  /** Самый тёмный или самый светлый текст — что читается на акценте. */
  textOnAccent: string;
}

export interface AccentPreset {
  id: string;
  /** Подпись в настройках. */
  label: string;
  hex: string;
}

/**
 * Готовая палитра: светло-голубой по умолчанию, остальные — пастель той же
 * мягкости, чтобы ни один выбор не выбивался из общего вида.
 *
 * Светлота держится в диапазоне 70–82%: на тёмной подложке такой цвет читается
 * без свечения, а на светлой теме не выгорает в белизну. Насыщенность подобрана
 * на глаз под каждый тон, а не по общему правилу, — «Сталь» намеренно почти
 * серая, а «Лёд» взят на пределе чистоты, иначе голубой уходит в грязь.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  /*
   * «Лазурь» — тот же голубой, что и «Лёд», но на 16 пунктов темнее (светлота
   * 62 против 78). Она выпадает из общего диапазона 70–82% намеренно и одна:
   * пастельный акцент на тёмной подложке почти не отличался от белого текста,
   * и приложение читалось как чёрно-белое с редкими светлыми пятнами. Владелец
   * попросил «один голубой, но глубже» — это он.
   */
  { id: 'azure', label: 'Лазурь', hex: '#419efb' },
  { id: 'ice', label: 'Лёд', hex: '#8fc7ff' },
  { id: 'sky', label: 'Небо', hex: '#7fb0f5' },
  { id: 'mint', label: 'Мята', hex: '#8fe0c8' },
  { id: 'lavender', label: 'Лаванда', hex: '#b3aef0' },
  { id: 'lilac', label: 'Сирень', hex: '#d3a9ec' },
  { id: 'rose', label: 'Роза', hex: '#f2a3bd' },
  { id: 'coral', label: 'Коралл', hex: '#f7a68f' },
  { id: 'sand', label: 'Песок', hex: '#e8c48f' },
  { id: 'moss', label: 'Мох', hex: '#b4d78f' },
  { id: 'steel', label: 'Сталь', hex: '#a9bcd0' }
] as const;

export const DEFAULT_ACCENT_ID = 'azure';

/** Акцент по умолчанию — насыщенный голубой, как просил владелец. */
export const DEFAULT_ACCENT_HEX =
  ACCENT_PRESETS.find((preset) => preset.id === DEFAULT_ACCENT_ID)?.hex ?? '#419efb';

export type ThemeDepth = 'night' | 'dusk' | 'steel' | 'light';

export interface ThemeDepthOption {
  id: ThemeDepth;
  label: string;
  description: string;
}

/**
 * Глубина — это насколько тёмная подложка, а не отдельная тема: токены
 * называются одинаково во всех четырёх, меняются только значения.
 */
export const THEME_DEPTHS: readonly ThemeDepthOption[] = [
  { id: 'night', label: 'Ночь', description: 'Почти чёрный фон — для тёмной комнаты и OLED' },
  { id: 'dusk', label: 'Сумерки', description: 'Тёмно-синий полумрак — вид по умолчанию' },
  { id: 'steel', label: 'Сталь', description: 'Светлее сумерек, мягче контраст' },
  { id: 'light', label: 'Светлая', description: 'Белая тема для яркого помещения' }
] as const;

export const DEFAULT_THEME_DEPTH: ThemeDepth = 'dusk';

const THEME_DEPTH_IDS = new Set<string>(THEME_DEPTHS.map((depth) => depth.id));

export function isThemeDepth(value: unknown): value is ThemeDepth {
  return typeof value === 'string' && THEME_DEPTH_IDS.has(value);
}

/**
 * Приводит запись цвета к `#rrggbb`.
 *
 * Принимает и короткую форму `#abc`, и запись без решётки: значение приходит из
 * поля ввода, где человек печатает как привык. Возвращает `null` на всём, что
 * цветом не является, — вызывающий сам решает, что делать с мусором, вместо
 * того чтобы получить молча подставленный чёрный.
 */
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/^#/, '').toLowerCase();

  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`;
  }
  if (/^[0-9a-f]{6}$/.test(raw)) {
    return `#${raw}`;
  }
  return null;
}

/**
 * Каналы 0–255 из записи цвета.
 *
 * Нормализует вход сам, а не требует этого от вызывающего. Причина в том, во
 * что превращалась небрежность: `Number.parseInt('red', 16)` — это `NaN`, а
 * `NaN & 255` — ноль, то есть на мусоре получался вполне правдоподобный чёрный.
 * Такую ошибку не видно ни в типах, ни в глазах — цвет просто оказывается не
 * тем. На нераспознанном входе берётся акцент по умолчанию: подставить заведомо
 * рабочий цвет честнее, чем тихо выдать чёрный.
 */
function hexChannels(input: string): [number, number, number] {
  const hex = normalizeHex(input) ?? DEFAULT_ACCENT_HEX;
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function hexToHsl(hex: string): Hsl {
  const [r255, g255, b255] = hexChannels(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l: l * 100 };
  }

  // Насыщенность считается от того, в какую половину светлоты попал цвет:
  // у очень тёмного и очень светлого запас до края меньше.
  const s = delta / (1 - Math.abs(2 * l - 1));

  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;

  h *= 60;
  if (h < 0) h += 360;

  return { h, s: s * 100, l: l * 100 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];

  const hex = rgb
    .map((channel) => Math.round((channel + m) * 255))
    .map((channel) => clamp(channel, 0, 255).toString(16).padStart(2, '0'))
    .join('');

  return `#${hex}`;
}

/**
 * Относительная яркость по WCAG 2.1.
 *
 * Каналы сначала разгамировываются: связь между записью цвета и воспринимаемой
 * яркостью нелинейная, и без этого шага светло-жёлтый и синий с одинаковой
 * светлотой в HSL получают одинаковую оценку, хотя на первом чёрный текст
 * читается, а на втором нет.
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexChannels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст двух цветов по WCAG: от 1 (одинаковые) до 21 (чёрный к белому). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Самый тёмный текст, что у нас есть; совпадает с базой тёмной темы. */
const INK = '#0b0f16';
const PAPER = '#ffffff';

/**
 * Что положить на акцент, чтобы подпись читалась.
 *
 * Выбор не по светлоте, а по фактическому контрасту с обоими вариантами: на
 * пастельном голубом чёрный даёт больше 10:1, на насыщённом индиго — меньше 4:1,
 * и там нужен белый. Порог не зашит, потому что вариантов всего два и берётся
 * лучший из них: даже если оба ниже AA, выбрать читаемее всё равно правильно.
 */
export function pickTextOnAccent(accentHex: string): string {
  return contrastRatio(accentHex, INK) >= contrastRatio(accentHex, PAPER) ? INK : PAPER;
}

/** `rgba()` из hex — CSS не умеет сделать это из переменной с hex внутри. */
export function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexChannels(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Насколько ступень состояния отходит от покоя по светлоте, в пунктах. */
const HOVER_STEP = 7;
const ACTIVE_STEP = 8;

/**
 * Выводит все оттенки одного акцента.
 *
 * Обычно наведение светлее покоя, а нажатие темнее. У краёв шкалы так не
 * выходит: осветлять почти белое и затемнять почти чёрное некуда, шаг упирается
 * в потолок или в пол, и состояние становится неотличимым от покоя. Поэтому у
 * светлого края обе ступени идут вниз, у тёмного — обе вверх, и в любом случае
 * между покоем, наведением и нажатием остаётся видимая разница. Проверять это
 * приходится тестом: пипетка принимает и `#ffffff`, и `#000000`.
 *
 * Насыщенность на осветляющей ступени чуть падает — иначе осветление уводит
 * пастель в кислотный тон. На затемняющих ступенях она остаётся: там этого
 * эффекта нет.
 */
export function deriveAccentShades(inputHex: string): AccentShades {
  const hex = normalizeHex(inputHex) ?? DEFAULT_ACCENT_HEX;
  const { h, s, l } = hexToHsl(hex);

  // Края берутся с запасом на сам шаг, а не по «почти белому»: важно не то,
  // насколько цвет светлый, а хватает ли ему места на ступень.
  const noRoomAbove = l + HOVER_STEP > 100;
  const noRoomBelow = l - ACTIVE_STEP < 0;

  let hoverLight: number;
  let activeLight: number;

  if (noRoomAbove) {
    hoverLight = l - HOVER_STEP;
    activeLight = l - HOVER_STEP - ACTIVE_STEP;
  } else if (noRoomBelow) {
    hoverLight = l + HOVER_STEP;
    activeLight = l + HOVER_STEP + ACTIVE_STEP;
  } else {
    hoverLight = l + HOVER_STEP;
    activeLight = l - ACTIVE_STEP;
  }

  // Осветляющей ступени убавляем насыщенность, затемняющей — нет.
  const hoverSat = hoverLight > l ? s * 0.97 : s;

  return {
    accent: hex,
    accentHover: hslToHex({ h, s: hoverSat, l: hoverLight }),
    accentActive: hslToHex({ h, s, l: activeLight }),
    accentSoft: hexToRgba(hex, 0.14),
    borderAccent: hexToRgba(hex, 0.45),
    ringColor: hexToRgba(hex, 0.7),
    textOnAccent: pickTextOnAccent(hex)
  };
}

/**
 * Самая светлая подложка светлой темы: `--surface-1` там белый, и именно на нём
 * акцент чаще всего оказывается не заливкой, а надписью или глифом.
 */
const LIGHT_SURFACE = '#ffffff';

/** Порог AA для обычного текста. */
const MIN_TEXT_CONTRAST = 4.5;

/** Шаг затемнения, в пунктах светлоты. */
const DARKEN_STEP = 2;

/**
 * Приводит акцент к глубине темы.
 *
 * Пастель на тёмном фоне читается прекрасно, а на белом почти исчезает: у
 * `#8fc7ff` контраст с белым около 1.6:1, тогда как акцентом в приложении
 * покрашены семь десятков надписей и глифов, а не только заливки кнопок. Поэтому
 * в светлой теме тот же тон опускается по светлоте, пока не наберёт контраст AA:
 * цвет остаётся узнаваемо тем же, но его наконец видно. У тёмных глубин цвет не
 * меняется вовсе.
 *
 * Возвращается именно база, а не весь набор: оттенки выводит
 * `deriveAccentShades`, и ему нужно передать уже приведённый цвет, иначе
 * наведение, нажатие и цвет текста на кнопке остались бы посчитанными от
 * пастели — то есть кнопка стала бы тёмно-синей с почти чёрной надписью.
 */
export function accentForDepth(inputHex: string, depth: ThemeDepth): string {
  const hex = normalizeHex(inputHex) ?? DEFAULT_ACCENT_HEX;
  if (depth !== 'light') return hex;

  const { h, s, l: startLight } = hexToHsl(hex);
  let light = startLight;
  let candidate = hex;

  // Цикл, а не формула: контраст нелинеен по светлоте и зависит от тона, одним
  // умножением нужного значения не получить. Шагов не больше пятидесяти, и на
  // чёрном контраст с белым равен 21 — выход гарантирован.
  while (light > 0 && contrastRatio(candidate, LIGHT_SURFACE) < MIN_TEXT_CONTRAST) {
    light = Math.max(0, light - DARKEN_STEP);
    candidate = hslToHex({ h, s, l: light });
  }

  return candidate;
}

/**
 * Имена CSS-переменных, которыми акцент попадает в стили.
 *
 * Список отдельно от применения, потому что применяет его тема в рендерере, а
 * проверяет тест: так видно, что ни одна переменная акцента не потерялась по
 * пути и в CSS не осталось зашитого сиреневого.
 */
export const ACCENT_CSS_VARS: Readonly<Record<keyof AccentShades, string>> = {
  accent: '--accent',
  accentHover: '--accent-hover',
  accentActive: '--accent-active',
  accentSoft: '--accent-soft',
  borderAccent: '--border-accent',
  ringColor: '--ring-color',
  textOnAccent: '--text-on-accent'
} as const;
