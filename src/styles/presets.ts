import { hexToRgba, hslToHex, type ThemeDepth } from './palette';
import { type FontId } from './typography';
import { type PlayerSkinId } from './playerSkins';

/**
 * Пресеты оформления: характер интерфейса целиком, а не набор цветов.
 *
 * Зачем это существует. Раньше вид приложения задавала таблица стилей, и
 * настраивался в нём один акцент. Всё остальное — скругления, толщина границ,
 * плотность отступов, глубина теней, скорость движения, стекло, зерно, частицы —
 * было вписано намертво. Пресет меняет именно это: два пресета на одной и той же
 * глубине темы и с одним акцентом выглядят как два разных приложения.
 *
 * Как пресет и глубина делят обязанности:
 *
 *   глубина (`data-theme`) — насколько темно;
 *   пресет               — какой характер: округлый и мягкий или острый и плоский.
 *
 * Поэтому лестница поверхностей здесь не таблица готовых цветов, а формула:
 * глубина даёт начальную светлоту и шаг, пресет — подтон, насыщенность и
 * множитель шага. Любая пара сочетается, и добавление пресета не требует
 * дописывать по четыре набора цветов на каждый.
 *
 * Почему это в JS, а не в CSS. Значений на пресет больше сорока, и половина —
 * производные (границы светлее подложки ровно настолько, тень глубже во столько
 * раз). В CSS такое выражается либо копипастой, либо `color-mix`, который в
 * Electron 43 ещё не везде считается предсказуемо. Результат уходит в инлайновый
 * `style` элемента `<html>` — он перебивает `:root` и не требует лишнего тега
 * `<style>`.
 *
 * Блоки `[data-theme]` в theme.css при этом не мёртвые: они рисуют самый первый
 * кадр, пока не выполнился JS, — иначе окно моргнёт белым.
 */

export type PresetId = 'island' | 'obsidian' | 'aurora' | 'neon' | 'paper' | 'haze';

/** Как рисуются тени. Влияет и на подъём панелей, и на общее настроение. */
type ShadowMode = 'none' | 'soft' | 'deep' | 'glow';

/** Набор кривых движения. */
type EaseMode = 'smooth' | 'spring' | 'snap';

/** Профиль поля частиц. Сам слой — `src/components/fx/ParticleField.tsx`. */
export type ParticleProfileId = 'off' | 'sparks' | 'mist' | 'rain' | 'storm';

export interface DesignPreset {
  id: PresetId;
  label: string;
  description: string;
  /** Гарнитура, с которой пресет задуман. Человек может сменить её отдельно. */
  fontId: FontId;
  /**
   * Пресет может требовать определённой глубины: «Бумага» на почти чёрной базе
   * не бумага. `null` — сочетается с любой.
   */
  forceDepth: ThemeDepth | null;

  /** Подтон поверхностей: тон и насыщенность в HSL. */
  hue: number;
  sat: number;
  /** Множитель шага лестницы поверхностей: больше — заметнее разница слоёв. */
  lift: number;
  /** Базовая прозрачность границ. 0.03 — граница на пределе видимости. */
  borderAlpha: number;

  /** Скругления: xs, sm, md, lg, xl, pill. */
  radius: readonly [number, number, number, number, number, number];

  shadow: ShadowMode;
  /** Размытие стекла в пикселях. 0 — стекла нет, всплывающие слои плотные. */
  glassBlur: number;
  /** Непрозрачность стеклянных подложек. */
  glassAlpha: number;
  /** Зерно поверх всего: разбивает бандинг на больших заливках. */
  grain: number;

  /** Множитель отступов. Меняет воздух, но не размеры органов управления. */
  density: number;
  /** Множитель длительностей. Меньше единицы — интерфейс отвечает резче. */
  motion: number;
  ease: EaseMode;
  particles: ParticleProfileId;

  /** Каркас: ширина боковой панели, высота шапки и полосы плеера. */
  frame: { sidebar: number; header: number; player: number };

  /**
   * Облик полосы плеера, с которым пресет задуман. `null` — любой подойдёт.
   *
   * Нужен ровно одному пресету — «Дымке», и не для красоты: её смысл в том,
   * что содержимое просвечивает сквозь панели, а полоса плеера — самая большая
   * панель в окне. С непрозрачной полосой от пресета остаётся половина.
   *
   * Выбор человека при этом старше: если он уже менял облик руками, пресет его
   * не трогает — то же правило, что и с гарнитурой.
   */
  playerSkinId: PlayerSkinId | null;
}

export const DESIGN_PRESETS: readonly DesignPreset[] = [
  {
    id: 'island',
    label: 'Островок',
    description: 'Почти чёрный фон, сдержанные скругления, границ почти нет — вид по умолчанию',
    fontId: 'onest',
    forceDepth: null,
    hue: 222,
    sat: 14,
    lift: 1,
    borderAlpha: 0.035,
    /*
     * Раньше лестница шла [12, 18, 24, 32, 40] и всё скруглялось почти до пилюли.
     * Так вид по умолчанию и получал свой шаблонный оттенок: у кнопки на 18 px
     * форма перестаёт читаться как кнопка, а карточка на 32 px рядом с ней спорит
     * за ту же роль — разница между ступенями пропадает, остаётся общая
     * «мягкость». Сдержаннее: кнопка на 10 px, карточка на 14, панель на 18.
     * Кому нужна прежняя округлость — она осталась готовым выбором в настройках
     * («Круглые» и «Пилюля» в RADIUS_SCALES ниже).
     */
    radius: [8, 10, 14, 18, 24, 999],
    shadow: 'deep',
    glassBlur: 44,
    glassAlpha: 0.72,
    grain: 0.03,
    density: 1,
    motion: 1,
    ease: 'spring',
    /*
     * По умолчанию поле частиц выключено.
     *
     * Раньше здесь стояли «Искры»: акцентные светящиеся точки со следами,
     * всплывающие под интерфейсом постоянно. Проблема не в том, что это плохо
     * нарисовано, — а в том, что это фоновая анимация, которую никто не просил
     * и которая ничего не сообщает. Она держит на себе внимание в приложении,
     * где смотреть надо на обложку и на список, а не на фон, и заодно крутит
     * requestAnimationFrame всё время, пока окно открыто, — на слабой встройке
     * и на батарее это заметно. Все четыре профиля остались готовым выбором
     * в настройках оформления: кому нужны искры, тот включит их одним щелчком.
     */
    particles: 'off',
    /*
     * Полоса плеера — 88, а не 96.
     *
     * Владелец сказал про неё «островок управления слишком в целом большой».
     * Замерено: самый высокий ряд внутри полосы — транспорт с дорожкой, 65 px.
     * При 96 над ним и под ним оставалось по 15 px пустоты, и полоса читалась
     * как панель, а не как подпись под окном. 88 оставляет по 11 — воздух ещё
     * есть, а лишней высоты уже нет.
     */
    frame: { sidebar: 264, header: 60, player: 88 },
    playerSkinId: null
  },
  {
    id: 'obsidian',
    label: 'Обсидиан',
    description: 'Плоско и строго: острые углы, видимые границы, без теней и без частиц',
    fontId: 'tight',
    forceDepth: null,
    hue: 210,
    sat: 4,
    lift: 1.2,
    borderAlpha: 0.13,
    radius: [3, 5, 8, 10, 12, 14],
    shadow: 'none',
    glassBlur: 0,
    glassAlpha: 0.94,
    grain: 0.012,
    density: 0.92,
    motion: 0.7,
    ease: 'snap',
    particles: 'off',
    frame: { sidebar: 244, header: 50, player: 78 },
    playerSkinId: null
  },
  {
    id: 'aurora',
    label: 'Аврора',
    description: 'Синий полумрак, много воздуха и стекла, медленные плавные движения',
    fontId: 'manrope',
    forceDepth: null,
    hue: 234,
    sat: 26,
    lift: 0.85,
    borderAlpha: 0.06,
    radius: [10, 15, 21, 28, 36, 999],
    shadow: 'soft',
    glassBlur: 64,
    glassAlpha: 0.62,
    grain: 0.042,
    density: 1.08,
    motion: 1.3,
    ease: 'smooth',
    particles: 'mist',
    frame: { sidebar: 280, header: 66, player: 104 },
    playerSkinId: null
  },
  {
    id: 'neon',
    label: 'Неон',
    description: 'Высокий контраст и свечение акцентом, быстрые резкие переходы',
    fontId: 'tight',
    forceDepth: 'night',
    hue: 258,
    sat: 18,
    lift: 1.35,
    borderAlpha: 0.1,
    radius: [6, 9, 13, 17, 22, 999],
    shadow: 'glow',
    glassBlur: 28,
    glassAlpha: 0.78,
    grain: 0.05,
    density: 0.96,
    motion: 0.8,
    ease: 'snap',
    particles: 'rain',
    frame: { sidebar: 252, header: 54, player: 86 },
    playerSkinId: null
  },
  {
    id: 'paper',
    label: 'Бумага',
    description: 'Светлое оформление: мягкие тени, спокойный текстовый шрифт, без частиц',
    fontId: 'golos',
    forceDepth: 'light',
    hue: 226,
    sat: 10,
    lift: 1,
    borderAlpha: 0.11,
    radius: [8, 12, 17, 22, 28, 999],
    shadow: 'soft',
    glassBlur: 26,
    glassAlpha: 0.78,
    grain: 0.008,
    density: 1.04,
    motion: 1,
    ease: 'smooth',
    particles: 'off',
    frame: { sidebar: 258, header: 58, player: 90 },
    playerSkinId: null
  },
  {
    /*
     * Дымка. Пресет про одно: содержимое просвечивает сквозь то, что лежит
     * поверх него, и на границе размывается.
     *
     * Владелец показал этот вид на снимке — название трека, наполовину ушедшее
     * под полосу плеера и растворившееся в ней, — и попросил тему, где так
     * выглядит всё. Отсюда три числа, которые здесь главные:
     * `glassAlpha` вдвое ниже, чем у остальных (сквозь `0.72` почти ничего не
     * видно), `glassBlur` самый большой из всех, а `lift` наоборот низкий —
     * ступени поверхностей нарочно сближены, чтобы глубину давало размытие, а
     * не разница заливок. С обычной лестницей стекло читается как грязь.
     *
     * `playerSkinId: 'glass'` — не украшение: полоса плеера здесь самая большая
     * стеклянная поверхность в окне, и именно под ней видно эффект целиком.
     */
    id: 'haze',
    label: 'Дымка',
    description: 'Матовое стекло: панели просвечивают, а то, что под ними, мягко размывается',
    fontId: 'manrope',
    forceDepth: null,
    hue: 218,
    sat: 16,
    lift: 0.62,
    borderAlpha: 0.05,
    radius: [10, 14, 20, 26, 34, 999],
    shadow: 'soft',
    glassBlur: 80,
    glassAlpha: 0.44,
    grain: 0.03,
    density: 1.04,
    motion: 1.15,
    ease: 'smooth',
    /*
     * Единственный пресет, которому поле частиц включено по умолчанию, и
     * профиль здесь не украшение: «Дымка» — это воздух между глазом и
     * картинкой. Слой `.haze-steam` даёт пар поверх интерфейса, `mist` — то же
     * самое под ним, и вместе они читаются как глубина, а не как плёнка.
     */
    particles: 'mist',
    frame: { sidebar: 268, header: 62, player: 92 },
    playerSkinId: 'glass'
  }
] as const;

export const DEFAULT_PRESET_ID: PresetId = 'island';

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && DESIGN_PRESETS.some((preset) => preset.id === value);
}

export function findPreset(id: PresetId): DesignPreset {
  return DESIGN_PRESETS.find((preset) => preset.id === id) ?? DESIGN_PRESETS[0];
}

/* ==========================================================================
   Ручки поверх пресета

   Пресет — это готовое сочетание, но человек вправе не согласиться с одной его
   чертой, не отказываясь от остальных. `null` означает «как в пресете», поэтому
   смена пресета сразу видна во всём, что человек не тронул руками.
   ========================================================================== */

export type RadiusOverride = 'sharp' | 'soft' | 'round' | 'pill';
export type DensityOverride = 'tight' | 'normal' | 'airy';
export type MotionOverride = 'instant' | 'fast' | 'normal' | 'slow';

export interface DesignOverrides {
  radius: RadiusOverride | null;
  density: DensityOverride | null;
  motion: MotionOverride | null;
  particles: ParticleProfileId | null;
  /** Стекло целиком: дорогое размытие можно выключить, не меняя пресет. */
  glass: boolean | null;
  grain: boolean | null;
}

export const NO_OVERRIDES: DesignOverrides = {
  radius: null,
  density: null,
  motion: null,
  particles: null,
  glass: null,
  grain: null
};

/** Готовые лестницы скруглений для ручного выбора. */
const RADIUS_SCALES: Readonly<Record<RadiusOverride, DesignPreset['radius']>> = {
  sharp: [2, 4, 6, 8, 10, 12],
  soft: [6, 9, 13, 17, 22, 28],
  round: [10, 15, 21, 28, 36, 999],
  pill: [14, 22, 30, 40, 52, 999]
};

const DENSITY_FACTORS: Readonly<Record<DensityOverride, number>> = {
  tight: 0.86,
  normal: 1,
  airy: 1.16
};

const MOTION_FACTORS: Readonly<Record<MotionOverride, number>> = {
  instant: 0.35,
  fast: 0.7,
  normal: 1,
  slow: 1.5
};

export const RADIUS_OPTIONS: readonly { id: RadiusOverride; label: string }[] = [
  { id: 'sharp', label: 'Острые' },
  { id: 'soft', label: 'Мягкие' },
  { id: 'round', label: 'Круглые' },
  { id: 'pill', label: 'Пилюля' }
] as const;

export const DENSITY_OPTIONS: readonly { id: DensityOverride; label: string }[] = [
  { id: 'tight', label: 'Плотно' },
  { id: 'normal', label: 'Обычно' },
  { id: 'airy', label: 'Просторно' }
] as const;

export const MOTION_OPTIONS: readonly { id: MotionOverride; label: string }[] = [
  { id: 'instant', label: 'Мгновенно' },
  { id: 'fast', label: 'Быстро' },
  { id: 'normal', label: 'Обычно' },
  { id: 'slow', label: 'Плавно' }
] as const;

export const PARTICLE_OPTIONS: readonly { id: ParticleProfileId; label: string; description: string }[] = [
  { id: 'off', label: 'Выключены', description: 'Ничего не рисуется, кадры не тратятся' },
  // Прежнее описание ссылалось на «Островок» — там искры больше не стоят.
  { id: 'sparks', label: 'Искры', description: 'Редкие точки со следами, всплывают вверх' },
  { id: 'mist', label: 'Дымка', description: 'Медленные крупные пятна, почти незаметные' },
  { id: 'rain', label: 'Струи', description: 'Тонкие вертикальные штрихи' },
  { id: 'storm', label: 'Буря', description: 'Плотный поток: красиво и заметно дороже' }
] as const;

export function isParticleProfileId(value: unknown): value is ParticleProfileId {
  return typeof value === 'string' && PARTICLE_OPTIONS.some((item) => item.id === value);
}

export function isRadiusOverride(value: unknown): value is RadiusOverride {
  return typeof value === 'string' && value in RADIUS_SCALES;
}

export function isDensityOverride(value: unknown): value is DensityOverride {
  return typeof value === 'string' && value in DENSITY_FACTORS;
}

export function isMotionOverride(value: unknown): value is MotionOverride {
  return typeof value === 'string' && value in MOTION_FACTORS;
}

/* ==========================================================================
   Глубина темы

   Начальная светлота и шаг лестницы. Всё остальное — производные, поэтому
   добавить пятую глубину значит дописать одну строку, а не сорок цветов.
   ========================================================================== */

interface DepthBase {
  /** Светлота основного фона, %. */
  base: number;
  /** Шаг между слоями, %. В светлой теме тоже положительный: слои идут к белому. */
  step: number;
  /** Светлая тема меняет полярность границ, текста и подложек наведения. */
  light: boolean;
}

const DEPTH_BASES: Readonly<Record<ThemeDepth, DepthBase>> = {
  night: { base: 2.4, step: 2.1, light: false },
  dusk: { base: 6.4, step: 2.5, light: false },
  steel: { base: 12, step: 2.9, light: false },
  light: { base: 94, step: 1.7, light: true }
};

/**
 * Лестница поверхностей.
 *
 * Шаги неравномерные и растут: разница между фоном и первой панелью должна быть
 * на границе восприятия, а между третьим и четвёртым слоем — уже очевидной, иначе
 * всплывающее меню сливается с панелью, на которой лежит.
 */
const SURFACE_STOPS = [-0.8, 0, 1, 1.9, 2.9, 4] as const;
const SURFACE_NAMES = [
  '--surface-sunken',
  '--bg-base',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--surface-4'
] as const;

/**
 * Насыщенность подтона гаснет к светлым слоям: при постоянной насыщенности
 * верхние панели становятся заметно синими, и приложение выглядит крашеным.
 */
function surfaceSat(sat: number, index: number, light: boolean): number {
  const fade = light ? 0.55 : 1 - index * 0.06;
  return Math.max(0, sat * fade);
}

function surfaceRamp(preset: DesignPreset, depth: DepthBase): Record<string, string> {
  const out: Record<string, string> = {};
  SURFACE_STOPS.forEach((stop, index) => {
    const lightness = depth.base + stop * depth.step * preset.lift;
    out[SURFACE_NAMES[index]] = hslToHex({
      h: preset.hue,
      s: surfaceSat(preset.sat, index, depth.light),
      // Ниже 1.2% цвета сливаются в чистый чёрный и подтон теряется, выше 99.6%
      // белые панели перестают отличаться друг от друга.
      l: Math.min(99.6, Math.max(1.2, lightness))
    });
  });
  return out;
}

/* ==========================================================================
   Тени
   ========================================================================== */

function shadowVars(mode: ShadowMode, light: boolean, accentHex: string): Record<string, string> {
  // На светлом фоне чёрная тень той же плотности выглядит грязным пятном:
  // тот же рисунок, но втрое прозрачнее.
  const k = light ? 0.34 : 1;
  const ink = (alpha: number) => `rgba(4, 6, 10, ${(alpha * k).toFixed(3)})`;

  if (mode === 'none') {
    // Полного отказа от тени быть не может: у всплывающих слоёв должен остаться
    // хоть какой-то контакт с подложкой, иначе меню читается как часть страницы.
    return {
      '--shadow-xs': 'none',
      '--shadow-sm': 'none',
      '--shadow-md': `0 2px 6px ${ink(0.2)}`,
      '--shadow-lg': `0 4px 16px ${ink(0.3)}`,
      '--highlight-top': 'none'
    };
  }

  if (mode === 'glow') {
    // Свечение — вторым слоем поверх обычной тени, а не вместо неё: без чёрного
    // слоя панель теряет вес и начинает парить без опоры.
    const halo = (spread: number, alpha: number) => `0 0 ${spread}px ${hexToRgba(accentHex, alpha)}`;
    return {
      '--shadow-xs': `0 1px 2px ${ink(0.3)}`,
      '--shadow-sm': `0 1px 3px ${ink(0.34)}, ${halo(10, 0.07)}`,
      '--shadow-md': `0 3px 10px ${ink(0.4)}, ${halo(22, 0.1)}`,
      '--shadow-lg': `0 8px 28px ${ink(0.5)}, ${halo(44, 0.14)}`,
      '--highlight-top': `inset 0 1px 0 ${hexToRgba(accentHex, 0.16)}`
    };
  }

  if (mode === 'soft') {
    return {
      '--shadow-xs': `0 1px 2px ${ink(0.14)}`,
      '--shadow-sm': `0 2px 6px ${ink(0.16)}`,
      '--shadow-md': `0 6px 18px ${ink(0.18)}`,
      '--shadow-lg': `0 14px 44px ${ink(0.22)}`,
      '--highlight-top': light ? 'inset 0 1px 0 rgba(255, 255, 255, 0.7)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.05)'
    };
  }

  // deep: короткий плотный слой рисует контакт с подложкой, длинный размытый —
  // саму высоту. Цвет строго нейтральный: цветная тень читается как свечение.
  return {
    '--shadow-xs': `0 1px 2px ${ink(0.26)}`,
    '--shadow-sm': `0 1px 3px ${ink(0.3)}, 0 3px 8px ${ink(0.22)}`,
    '--shadow-md': `0 2px 6px ${ink(0.34)}, 0 10px 26px ${ink(0.3)}`,
    '--shadow-lg': `0 6px 16px ${ink(0.4)}, 0 26px 60px ${ink(0.42)}`,
    '--highlight-top': light ? 'inset 0 1px 0 rgba(255, 255, 255, 0.7)' : 'inset 0 1px 0 rgba(255, 255, 255, 0.06)'
  };
}

/* ==========================================================================
   Движение
   ========================================================================== */

const EASE_SETS: Readonly<Record<EaseMode, Record<string, string>>> = {
  smooth: {
    '--ease-out': 'cubic-bezier(0.22, 1, 0.36, 1)',
    '--ease-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
    '--ease-spring': 'cubic-bezier(0.34, 1.2, 0.64, 1)',
    '--ease-morph': 'cubic-bezier(0.22, 0.61, 0.36, 1)'
  },
  spring: {
    '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    '--ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
    // Перелёт заметный, но один: 1.6 по второй контрольной точке даёт отдачу
    // примерно на 8% размера — этого хватает, чтобы движение читалось живым.
    '--ease-spring': 'cubic-bezier(0.34, 1.6, 0.54, 1)',
    '--ease-morph': 'cubic-bezier(0.2, 0.9, 0.24, 1)'
  },
  snap: {
    '--ease-out': 'cubic-bezier(0.3, 0, 0.1, 1)',
    '--ease-in-out': 'cubic-bezier(0.5, 0, 0.5, 1)',
    '--ease-spring': 'cubic-bezier(0.2, 1.1, 0.4, 1)',
    '--ease-morph': 'cubic-bezier(0.4, 0, 0.1, 1)'
  }
};

/** Базовые длительности до множителя, мс. */
const DURATIONS = { fast: 150, normal: 220, slow: 320, morph: 620 } as const;

/* ==========================================================================
   Итоговая сборка
   ========================================================================== */

export interface DesignSelection {
  presetId: PresetId;
  depth: ThemeDepth;
  accentHex: string;
  overrides: DesignOverrides;
}

/**
 * Сколько кадров держать уходящий элемент.
 *
 * Живёт здесь, а не в `motion.ts`, потому что теперь длительность зависит от
 * пресета и ручки: React должен снимать элемент из дерева ровно тогда, когда
 * кадры доиграли, а не через фиксированные 150 мс. `EXIT_MS` остаётся как
 * значение по умолчанию для кода, до которого выбор не доходит.
 */
export function exitDurationMs(selection: Pick<DesignSelection, 'presetId' | 'overrides'>): number {
  const preset = findPreset(selection.presetId);
  const factor = selection.overrides.motion ? MOTION_FACTORS[selection.overrides.motion] : preset.motion;
  return Math.round(DURATIONS.fast * factor);
}

/** Разрешённая частица: ручка старше пресета. */
export function resolveParticles(selection: Pick<DesignSelection, 'presetId' | 'overrides'>): ParticleProfileId {
  return selection.overrides.particles ?? findPreset(selection.presetId).particles;
}

/** Глубина, которую пресет допускает. Возвращает то же значение, если он не против. */
export function resolveDepth(presetId: PresetId, depth: ThemeDepth): ThemeDepth {
  return findPreset(presetId).forceDepth ?? depth;
}

/**
 * Полный набор переменных оформления.
 *
 * Карта, а не запись в документ: проверять сорок значений тестом проще без окна,
 * а применяет их `designService` — единственное место, которое трогает `<html>`.
 */
export function designVars(selection: DesignSelection): Record<string, string> {
  const preset = findPreset(selection.presetId);
  const depth = DEPTH_BASES[resolveDepth(preset.id, selection.depth)] ?? DEPTH_BASES.dusk;
  const { overrides } = selection;

  const radius = overrides.radius ? RADIUS_SCALES[overrides.radius] : preset.radius;
  const density = overrides.density ? DENSITY_FACTORS[overrides.density] : preset.density;
  const motion = overrides.motion ? MOTION_FACTORS[overrides.motion] : preset.motion;
  const glassOn = overrides.glass ?? preset.glassBlur > 0;
  const grainOn = overrides.grain ?? preset.grain > 0;

  // Полярность: на тёмном подложки и границы белые с прозрачностью, на светлом —
  // чёрные. Белое на белом не видно вовсе, поэтому одной формулой не обойтись.
  const veil = (alpha: number) =>
    depth.light ? `rgba(11, 15, 22, ${alpha.toFixed(3)})` : `rgba(255, 255, 255, ${alpha.toFixed(3)})`;

  const textSat = Math.min(18, preset.sat * 0.5);
  const text = (lightness: number) => hslToHex({ h: preset.hue, s: textSat, l: lightness });

  const vars: Record<string, string> = {
    ...surfaceRamp(preset, depth),
    ...shadowVars(preset.shadow, depth.light, selection.accentHex),
    ...EASE_SETS[preset.ease],

    '--surface-hover': veil(depth.light ? 0.045 : 0.05),
    '--surface-active': veil(depth.light ? 0.075 : 0.085),

    '--border-subtle': veil(preset.borderAlpha * 0.62),
    '--border': veil(preset.borderAlpha),
    '--border-strong': veil(Math.min(0.42, preset.borderAlpha * 1.9)),

    '--text-primary': text(depth.light ? 11 : 94),
    '--text-secondary': text(depth.light ? 31 : 73),
    '--text-muted': text(depth.light ? 43 : 60),
    '--text-faint': text(depth.light ? 57 : 45),

    '--radius-xs': `${radius[0]}px`,
    '--radius-sm': `${radius[1]}px`,
    '--radius-md': `${radius[2]}px`,
    '--radius-lg': `${radius[3]}px`,
    '--radius-xl': `${radius[4]}px`,
    '--radius-pill': radius[5] >= 999 ? '9999px' : `${radius[5]}px`,

    '--dur-fast': `${Math.round(DURATIONS.fast * motion)}ms`,
    '--dur-normal': `${Math.round(DURATIONS.normal * motion)}ms`,
    '--dur-slow': `${Math.round(DURATIONS.slow * motion)}ms`,
    '--dur-morph': `${Math.round(DURATIONS.morph * motion)}ms`,

    // Размытие ставится вместе с подложкой: полупрозрачная панель без размытия
    // показывает сквозь себя текст, и читать нельзя ни то, ни другое. Поэтому при
    // выключенном стекле подложка становится почти плотной.
    '--glass-blur': glassOn ? `blur(${preset.glassBlur}px) saturate(${depth.light ? 130 : 150}%)` : 'none',
    '--glass-bg': hexToRgba(
      hslToHex({ h: preset.hue, s: surfaceSat(preset.sat, 2, depth.light), l: depth.base + depth.step * preset.lift }),
      glassOn ? preset.glassAlpha : 0.97
    ),
    '--glass-bg-strong': hexToRgba(
      hslToHex({ h: preset.hue, s: surfaceSat(preset.sat, 1, depth.light), l: depth.base }),
      glassOn ? Math.min(0.96, preset.glassAlpha + 0.16) : 0.99
    ),
    '--glass-border': veil(Math.max(0.06, preset.borderAlpha * 1.4)),
    '--glass-highlight': depth.light
      ? 'inset 0 1px 0 rgba(255, 255, 255, 0.9)'
      : `inset 0 1px 0 rgba(255, 255, 255, ${(0.02 + preset.borderAlpha).toFixed(3)})`,

    '--scrim': depth.light ? 'rgba(20, 26, 38, 0.4)' : 'rgba(3, 4, 7, 0.66)',
    '--scrim-strong': depth.light ? 'rgba(20, 26, 38, 0.56)' : 'rgba(3, 4, 7, 0.84)',

    '--grain-opacity': grainOn ? preset.grain.toFixed(3) : '0',

    '--sidebar-width-expanded': `${Math.round(preset.frame.sidebar * (0.94 + density * 0.06))}px`,
    '--header-height': `${Math.round(preset.frame.header)}px`,
    '--player-bar-height': `${Math.round(preset.frame.player)}px`
  };

  // Отступы — единственная шкала, которую двигает плотность. Органы управления
  // остаются как есть: их размеры согласованы со шкалой иконок с точностью до
  // двух пикселей (tests/unit/iconScale.test.ts), и дробное масштабирование
  // поставило бы глиф на полпикселя.
  const spaceBase = [4, 8, 12, 16, 24, 32, 48, 64];
  spaceBase.forEach((value, index) => {
    vars[`--space-${index + 1}`] = `${Math.max(2, Math.round(value * density))}px`;
  });

  return vars;
}

/** Все имена, которые пишет `designVars`. Нужен, чтобы уметь их снять. */
export function designVarNames(): string[] {
  return Object.keys(
    designVars({
      presetId: DEFAULT_PRESET_ID,
      depth: 'dusk',
      accentHex: '#8fc7ff',
      overrides: NO_OVERRIDES
    })
  );
}
