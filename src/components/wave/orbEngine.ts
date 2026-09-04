import { WaveMood } from '../../types/store';
import {
  DEFAULT_ACCENT_HEX,
  DEFAULT_THEME_DEPTH,
  hexToHsl,
  hslToHex,
  normalizeHex,
  type ThemeDepth
} from '../../styles/palette';

/**
 * Внутренности шара «Потока»: цвета и разбор спектра.
 *
 * Всё, что можно посчитать без холста, живёт здесь, а не в компоненте. Причина
 * не в порядке ради порядка: в компоненте это код внутри `requestAnimationFrame`,
 * который тесту видно только по вызовам заглушки `CanvasRenderingContext2D`.
 * Отдельным модулем те же правила проверяются числами — а именно в числах шар и
 * ломался: тихая частота, съехавший оттенок, полоса спектра из мусора.
 */

/**
 * Сколько полос в ленте спектра.
 *
 * Двадцать восемь — это компромисс: меньше двадцати лента выглядит рублеными
 * зубцами, больше сорока — ровным кругом, потому что соседние полосы почти не
 * отличаются друг от друга и рисунок вырождается.
 */
export const BAND_COUNT = 28;

/**
 * Выше 192-й корзины у музыки почти нет энергии — там шипение и тишина.
 *
 * Раньше полосы считались до 127-й включительно и последняя треть ленты стояла
 * мёртвой. Ограничение сверху важнее, чем кажется: без него на анализаторе с
 * 2048 корзинами верхние полосы получают средние по огромным пустым отрезкам и
 * лента перестаёт отвечать на высокие вообще.
 */
const MAX_USEFUL_BIN = 192;

/** Меньше восьми корзин — не спектр, а обрывок: полосы из него не собрать. */
const MIN_USEFUL_BINS = 8;

export interface SpectrumLevels {
  /** Низ: пульсация ядра и удары. */
  bass: number;
  /** Середина: разброс ленты. */
  mid: number;
  /** Верх: пыль на орбите и мерцание. */
  treble: number;
}

const SILENCE: SpectrumLevels = { bass: 0, mid: 0, treble: 0 };

/**
 * Границы полос по корзинам анализатора.
 *
 * Шаг геометрический, а не равномерный: слух устроен так же, и на равномерном
 * шаге весь бас попадает в одну полосу, а десяток верхних полос делит между
 * собой шипение. Считается один раз на длину массива — длина меняется только
 * вместе с настройкой анализатора.
 */
const edgeCache = new Map<number, number[]>();

function bandEdges(usable: number): number[] {
  const cached = edgeCache.get(usable);
  if (cached) return cached;

  const edges: number[] = [];
  for (let i = 0; i <= BAND_COUNT; i++) {
    // Нулевая корзина — постоянная составляющая, музыки в ней нет, поэтому
    // отсчёт идёт с первой: `usable ** 0` даёт ровно её.
    const raw = Math.round(Math.pow(usable, i / BAND_COUNT));
    const previous = edges.length > 0 ? edges[edges.length - 1] : 0;
    // Полоса не может быть пустой: на коротком массиве геометрический шаг
    // возвращает одну и ту же корзину подряд, и без этой строки часть полос
    // осталась бы без ни одного отсчёта, то есть навсегда нулевой.
    edges.push(Math.min(usable, Math.max(previous + 1, raw)));
  }
  edgeCache.set(usable, edges);
  return edges;
}

/**
 * Черновик под сглаживание ленты, по одному на каждую длину.
 *
 * Сглаживать на месте нельзя: уже поправленная полоса стала бы соседом для
 * следующей, и ошибка ползла бы по всей ленте. Черновик кэшируется, потому что
 * сглаживание идёт каждый кадр, а новый массив шестьдесят раз в секунду — это
 * работа для сборщика мусора ровно там, где нельзя терять кадры.
 */
const smoothingScratch = new Map<number, Float32Array>();

/**
 * Размазывает ленту по соседним полосам ядром 1–2–1.
 *
 * Без этого одна громкая полоса вылезает на контуре одиноким шипом: соседние
 * полосы остаются низкими, и вместо волны получается зубец. Слух так звук и не
 * слышит — энергия в спектре размазана, а резкую границу между соседними
 * полосами создаёт сам разбор, деля непрерывный спектр на отрезки.
 *
 * По краям значение повторяется вместо нуля: иначе первая и последняя полосы
 * всегда оказывались бы тише остальных и лента поджималась бы к вертикали.
 */
function smoothBands(bands: Float32Array): void {
  const length = bands.length;
  if (length < 3) return;

  let scratch = smoothingScratch.get(length);
  if (!scratch) {
    scratch = new Float32Array(length);
    smoothingScratch.set(length, scratch);
  }
  scratch.set(bands);

  for (let i = 0; i < length; i++) {
    const previous = scratch[i > 0 ? i - 1 : 0];
    const next = scratch[i < length - 1 ? i + 1 : length - 1];
    bands[i] = (previous + scratch[i] * 2 + next) / 4;
  }
}

/**
 * Разбирает спектр на полосы и три уровня.
 *
 * Значения пишутся в переданный массив, а не возвращаются новым: разбор идёт
 * каждый кадр, и новый `Float32Array` шестьдесят раз в секунду — это работа для
 * сборщика мусора ровно там, где нельзя терять кадры.
 *
 * Каждый отсчёт проверяется на конечность. Это не паранойя: `getFrequencyData`
 * отдаёт то, что положил в буфер веб-аудио, и на закрытом контексте или
 * подменённом движке оттуда приходили и `NaN`, и отрицательные числа. Один `NaN`
 * дальше расходится по всей геометрии кадра, и шар просто пропадает с экрана —
 * без ошибки в консоли, потому что рисование `NaN` исключения не бросает.
 */
export function readSpectrum(
  freq: ArrayLike<number> | null | undefined,
  bands: Float32Array
): SpectrumLevels {
  const length = freq ? freq.length : 0;
  if (!freq || length < MIN_USEFUL_BINS) {
    bands.fill(0);
    return SILENCE;
  }

  const usable = Math.min(length, MAX_USEFUL_BIN);
  const edges = bandEdges(usable);

  let bassSum = 0;
  let midSum = 0;
  let trebleSum = 0;

  for (let b = 0; b < BAND_COUNT; b++) {
    // Корзин может оказаться меньше, чем полос: размер окна анализатора —
    // настройка, и на маленьком `fftSize` границы упираются в конец массива.
    // Тогда полосы делят корзины повторно, а не остаются пустыми: пустая полоса
    // — это мёртвый участок ленты, который не шевелится ни на одном треке.
    const from = Math.min(edges[b], usable - 1);
    const to = Math.max(from + 1, Math.min(edges[b + 1], usable));
    let sum = 0;
    let count = 0;

    for (let i = from; i < to && i < length; i++) {
      const raw = freq[i];
      sum += Number.isFinite(raw) ? Math.min(255, Math.max(0, raw)) : 0;
      count++;
    }

    const value = count > 0 ? sum / (count * 255) : 0;
    bands[b] = value;

    // Границы уровней совпадают с границами полос, а не с корзинами: иначе на
    // разных длинах массива «бас» означал бы разное.
    if (b < 4) bassSum += value;
    else if (b < 14) midSum += value;
    else trebleSum += value;
  }

  // Уровни считаются до сглаживания: они и так средние по своим участкам, а
  // лента сглаживается только ради формы контура.
  smoothBands(bands);

  return {
    bass: bassSum / 4,
    mid: midSum / 10,
    treble: trebleSum / (BAND_COUNT - 14)
  };
}
/**
 * Ниже этого порога сглаженное значение на глаз не отличить от нуля.
 *
 * Порог нужен потому, что экспоненциальное сглаживание к нулю не приходит
 * никогда: без него цикл «дожать затухание после паузы» не остановился бы.
 */
export const REST_EPSILON = 0.002;

/** Насколько быстро значение растёт и насколько медленно опадает. */
const ATTACK = 0.32;
const RELEASE = 0.08;

/**
 * Тянет текущие значения к новым.
 *
 * Подъём вчетверо быстрее спада — это не украшение, а разница между «шар
 * отвечает на удар» и «шар плавает сам по себе». На одинаковой скорости атака
 * сглаживается вместе с затуханием, и удар бочки превращается в вялую волну,
 * приходящую через треть секунды после самого звука.
 */
export function approach(current: number, target: number): number {
  return current + (target - current) * (target > current ? ATTACK : RELEASE);
}

/** То же для всей ленты полос, на месте. */
export function approachBands(current: Float32Array, target: Float32Array): void {
  const length = Math.min(current.length, target.length);
  for (let i = 0; i < length; i++) {
    current[i] = approach(current[i], target[i]);
  }
}

/** Всё затихло: и уровни, и лента. */
export function isAtRest(levels: SpectrumLevels, bands: Float32Array): boolean {
  if (
    Math.abs(levels.bass) >= REST_EPSILON ||
    Math.abs(levels.mid) >= REST_EPSILON ||
    Math.abs(levels.treble) >= REST_EPSILON
  ) {
    return false;
  }
  for (let i = 0; i < bands.length; i++) {
    if (Math.abs(bands[i]) >= REST_EPSILON) return false;
  }
  return true;
}

/**
 * Значение ленты под углом, с переходом между соседними полосами.
 *
 * Доля `t` — путь по кругу от нуля до единицы. Половина круга зеркалит вторую:
 * лента получается симметричной относительно вертикали, и это читается как
 * рисунок, а не как случайный частокол. Дробная часть между полосами
 * доливается линейно — без неё на двадцати восьми полосах видны ступеньки.
 */
export function bandAt(bands: Float32Array, t: number): number {
  if (bands.length === 0) return 0;

  // Путь туда и обратно: 0 → 1 → 0 за полный оборот.
  const wrapped = ((t % 1) + 1) % 1;
  const mirrored = wrapped < 0.5 ? wrapped * 2 : (1 - wrapped) * 2;

  const position = mirrored * (bands.length - 1);
  const index = Math.floor(position);
  const next = Math.min(bands.length - 1, index + 1);
  const fraction = position - index;

  // Доля выравнивается кривой, а не берётся линейно. На стыке двух полос
  // производная линейной доли меняется скачком, и контур получает излом — на
  // круге из ста двадцати восьми точек такой излом читается надкусом по краю.
  // У этой кривой производная на обоих концах равна нулю, поэтому полосы
  // переходят друг в друга без угла.
  const eased = fraction * fraction * (3 - 2 * fraction);

  return bands[index] * (1 - eased) + bands[next] * eased;
}

/**
 * Сдвиг оттенка и насыщенности под настроение — от живого акцента приложения.
 *
 * Ключевое слово «от акцента». Раньше у каждого настроения был свой набор
 * готовых цветов: фиолетовый, кислотно-зелёный, оранжевый. В приложении с
 * настраиваемым акцентом это означало, что главный экран — единственное место,
 * которое на выбранный цвет не отвечает вообще. Здесь настроение задаёт не цвет,
 * а поворот от акцента, поэтому шар остаётся своим при любой палитре.
 *
 * `spread` — второй оттенок, между ним и первым натянуты все градиенты кадра.
 */
interface MoodTint {
  hue: number;
  spread: number;
  sat: number;
  light: number;
}

export const MOOD_TINTS: Record<WaveMood, MoodTint> = {
  /** Спокойное — сам акцент, чуть светлее. */
  chill: { hue: 0, spread: 26, sat: 0.92, light: 4 },
  /** Незнакомое — поворот в бирюзу: холоднее акцента, но рядом с ним. */
  discovery: { hue: -36, spread: -30, sat: 1.04, light: 2 },
  /** Избранное — в сирень и розовое: тепло, но не жарко. */
  favorite: { hue: 78, spread: 34, sat: 1.08, light: 3 },
  /** Бодрое — на другую сторону круга, в тёплое. */
  energy: { hue: 168, spread: 30, sat: 1.16, light: 6 },
  /** Сосредоточенное — индиго: глубже и плотнее акцента. */
  focus: { hue: 42, spread: -22, sat: 1.0, light: -2 }
};

/**
 * Цвета кадра каналами через запятую («r, g, b»), а не как hex.
 *
 * Прозрачность в кадре меняется у каждого слоя и у каждой из десятков точек, то
 * есть строка цвета всё равно собирается заново. Из hex это ещё три `slice` и
 * три `parseInt` на каждую — тысячи разборов строки в секунду ради чисел,
 * известных заранее.
 */
export interface OrbPalette {
  /** Тело: самая яркая часть кольца. */
  core: string;
  /** Внешний край кольца и лента спектра. */
  ring: string;
  /** Рассеянное свечение вокруг. */
  halo: string;
  /** Пыль на орбите — почти белая, чтобы читалась искрой. */
  dust: string;
  /** Провал в середине кольца. */
  deep: string;
  /** Блик: белый с примесью акцента, иначе выглядит наклейкой. */
  sheen: string;
}

function channels(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

const paletteCache = new Map<string, OrbPalette>();

/**
 * Как глубина темы двигает светлоту слоёв.
 *
 * Раньше палитра о теме вообще не знала, и в светлой теме шар ломался целиком:
 * провал в середине кольца оставался почти чёрным пятном на белом окне, пыль со
 * светлотой восемьдесят четыре исчезала вместе с бликом, а само кольцо, взятое
 * от пастельного акцента, сливалось с подложкой. Получался чёрный круг в белом
 * листе — ровно то, чего у светящегося шара быть не должно.
 *
 * Сдвиг задан таблицей, а не формулой от светлоты фона: у слоёв разные роли.
 * Провал должен быть цвета окна, пыль — темнее окна, свечение — насыщеннее его,
 * и одним общим правилом эти три требования не выразить.
 */
interface DepthShift {
  /** Сдвиг светлоты светящихся слоёв: ядра, кольца и свечения. */
  glow: number;
  /** Светлота провала в середине кольца — она же цвет подложки окна. */
  deep: number;
  /** Светлота пыли на орбите. */
  dust: number;
  /** Светлота блика. */
  sheen: number;
  /** Множитель насыщенности: на светлом фоне цвет нужен плотнее. */
  sat: number;
}

const DEPTH_SHIFTS: Record<ThemeDepth, DepthShift> = {
  night: { glow: 1, deep: 7, dust: 86, sheen: 97, sat: 1 },
  dusk: { glow: 0, deep: 9, dust: 84, sheen: 97, sat: 1 },
  steel: { glow: -2, deep: 14, dust: 80, sheen: 95, sat: 0.98 },
  light: { glow: -22, deep: 93, dust: 46, sheen: 99, sat: 1.12 }
};

/**
 * Палитра шара из акцента, настроения и глубины темы.
 *
 * Результат кэшируется: акцент меняется движением ползунка в настройках, а не
 * каждый кадр, тогда как перевод hex → hsl → hex и обратно для шести цветов
 * стоит дороже всего остального разбора спектра.
 */
export function orbPalette(
  accentHex: string,
  mood: WaveMood,
  depth: ThemeDepth = DEFAULT_THEME_DEPTH
): OrbPalette {
  const accent = normalizeHex(accentHex) ?? DEFAULT_ACCENT_HEX;
  // Неизвестное настроение — не повод остаться без цвета: шар рисуется каждый
  // кадр, и пустая палитра здесь означала бы чёрный круг на весь экран.
  const tint = MOOD_TINTS[mood] ?? MOOD_TINTS.chill;
  const shift = DEPTH_SHIFTS[depth] ?? DEPTH_SHIFTS[DEFAULT_THEME_DEPTH];
  const key = `${accent}|${mood}|${depth}`;

  const cached = paletteCache.get(key);
  if (cached) return cached;

  const base = hexToHsl(accent);
  const hue = base.h + tint.hue;
  const sat = base.s * tint.sat * shift.sat;
  const light = base.l + tint.light + shift.glow;

  const palette: OrbPalette = {
    core: channels(hslToHex({ h: hue, s: sat, l: light + 8 })),
    ring: channels(hslToHex({ h: hue + tint.spread, s: sat, l: light + 14 })),
    halo: channels(hslToHex({ h: hue + tint.spread * 0.5, s: sat * 0.9, l: light })),
    dust: channels(hslToHex({ h: hue + tint.spread, s: sat * 0.55, l: shift.dust })),
    deep: channels(hslToHex({ h: hue, s: sat * 0.5, l: shift.deep })),
    sheen: channels(hslToHex({ h: hue, s: 32, l: shift.sheen }))
  };

  paletteCache.set(key, palette);
  return palette;
}
