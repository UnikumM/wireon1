import { describe, it, expect } from 'vitest';
import {
  BAND_COUNT,
  MOOD_TINTS,
  REST_EPSILON,
  approach,
  approachBands,
  bandAt,
  isAtRest,
  orbPalette,
  readSpectrum
} from '../../src/components/wave/orbEngine';
import {
  MAX_REACH,
  SHOCK_LIFE,
  advanceDust,
  createDustRing,
  createShockPool,
  paintOrb,
  pulseScale,
  spawnShock
} from '../../src/components/wave/orbRenderer';
import { DEFAULT_ACCENT_HEX } from '../../src/styles/palette';

/**
 * Шар «Потока» проверяется числами, а не картинкой.
 *
 * Всё, что видно на экране, — это результат разбора спектра и геометрии слоёв.
 * Именно там он и ломался раньше: тихая полоса, съехавший оттенок, обрезанное
 * углом свечение. Через заглушку холста такие вещи не поймать, поэтому обе
 * половины — разбор и рисование — вынесены из компонента и проверяются здесь.
 */

const bands = () => new Float32Array(BAND_COUNT);

/**
 * Заглушка холста, которая запоминает геометрию.
 *
 * Нужны не сами вызовы, а числа в них: настоящий `CanvasRenderingContext2D`
 * бросает `IndexSizeError` на отрицательном радиусе и молча рисует мимо экрана
 * на `NaN`. Первое — падение приложения, второе — пропавший шар без единой
 * строчки в консоли.
 */
function recorder() {
  const numbers: number[] = [];
  const arcs: Array<{ x: number; y: number; r: number; lineWidth: number }> = [];
  const points: Array<{ x: number; y: number }> = [];
  const radials: Array<{ r0: number; r1: number }> = [];
  /** Контрольные точки по контурам: `beginPath` начинает новый. */
  const paths: Array<Array<{ x: number; y: number }>> = [];
  let path: Array<{ x: number; y: number }> = [];
  const stops: string[] = [];

  const gradient = {
    addColorStop: (offset: number, colour: string) => {
      numbers.push(offset);
      stops.push(colour);
    }
  };

  const ctx = {
    lineWidth: 1,
    lineCap: 'butt',
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    beginPath: () => {
      path = [];
      paths.push(path);
    },
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: (x: number, y: number) => {
      numbers.push(x, y);
      points.push({ x, y });
    },
    lineTo: (x: number, y: number) => {
      numbers.push(x, y);
      points.push({ x, y });
    },
    // Контур рисуется кривыми, поэтому в проверку границ холста должны попасть
    // обе пары: и контрольная точка, и конец пера. Кривая целиком лежит в
    // выпуклой оболочке этих точек — проверив точки, мы проверили и кривую.
    quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => {
      numbers.push(cpx, cpy, x, y);
      points.push({ x: cpx, y: cpy });
      points.push({ x, y });
      // Контрольные точки складываются ещё и по контурам: ровность силуэта — это
      // свойство одного контура, и в общей куче точек всех слоёв её не увидеть.
      path.push({ x: cpx, y: cpy });
    },
    arc: (x: number, y: number, r: number, from: number, to: number) => {
      numbers.push(x, y, r, from, to);
      arcs.push({ x, y, r, lineWidth: ctx.lineWidth });
    },
    createRadialGradient: (x0: number, y0: number, r0: number, x1: number, y1: number, r1: number) => {
      numbers.push(x0, y0, r0, x1, y1, r1);
      radials.push({ r0, r1 });
      return gradient;
    },
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
      numbers.push(x0, y0, x1, y1);
      return gradient;
    }
  };

  return { ctx: ctx as unknown as CanvasRenderingContext2D, numbers, arcs, points, paths, radials, stops };
}

describe('Шар «Потока»', () => {
  describe('разбор спектра', () => {
    it('на пустом и коротком буфере отдаёт тишину, а не мусор', () => {
      const target = bands();
      target.fill(0.5);

      for (const input of [null, undefined, new Uint8Array(0), new Uint8Array(1), new Uint8Array(7)]) {
        const levels = readSpectrum(input, target);
        expect(levels).toEqual({ bass: 0, mid: 0, treble: 0 });
        expect([...target].every((value) => value === 0)).toBe(true);
      }
    });

    it('каждая полоса получает хотя бы одну корзину даже на коротком буфере', () => {
      // Шаг между полосами геометрический, и на шестнадцати корзинах он выдаёт
      // одно и то же число подряд. Без защиты часть полос осталась бы навсегда
      // нулевой, и лента спектра стояла бы с провалами.
      const target = bands();
      readSpectrum(new Uint8Array(16).fill(255), target);

      expect([...target].every((value) => value > 0.9)).toBe(true);
    });

    it('насыщенный буфер даёт единицу во всех полосах и уровнях', () => {
      const target = bands();
      const levels = readSpectrum(new Uint8Array(256).fill(255), target);

      expect(levels.bass).toBeCloseTo(1, 5);
      expect(levels.mid).toBeCloseTo(1, 5);
      expect(levels.treble).toBeCloseTo(1, 5);
      expect(Math.min(...target)).toBeCloseTo(1, 5);
    });

    it('обезвреживает NaN, бесконечности, отрицательные и запредельные отсчёты', () => {
      const dirty = new Array(256).fill(0);
      dirty[1] = Number.NaN;
      dirty[2] = Number.POSITIVE_INFINITY;
      dirty[3] = Number.NEGATIVE_INFINITY;
      dirty[10] = -400;
      dirty[64] = 999999;

      const target = bands();
      const levels = readSpectrum(dirty, target);

      for (const value of target) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(Number.isFinite(levels.bass)).toBe(true);
      expect(Number.isFinite(levels.treble)).toBe(true);
    });

    it('низ и верх попадают каждый в свои полосы', () => {
      const low = new Uint8Array(256);
      low.fill(255, 1, 6);
      const high = new Uint8Array(256);
      high.fill(255, 90, 180);

      const lowLevels = readSpectrum(low, bands());
      const highLevels = readSpectrum(high, bands());

      expect(lowLevels.bass).toBeGreaterThan(lowLevels.treble);
      expect(highLevels.treble).toBeGreaterThan(highLevels.bass);
    });

    it('не заглядывает выше полезной части спектра', () => {
      // На анализаторе с 4096 корзинами вся музыка лежит в первых двух сотнях.
      // Если границу не поставить, верхние полосы усредняют огромные пустые
      // отрезки и лента перестаёт отвечать на высокие вообще.
      const onlyVeryHigh = new Uint8Array(4096);
      onlyVeryHigh.fill(255, 400);

      const levels = readSpectrum(onlyVeryHigh, bands());

      expect(levels.treble).toBe(0);
      expect(levels.bass).toBe(0);
    });
  });

  describe('сглаживание', () => {
    it('поднимается заметно быстрее, чем опадает', () => {
      // Иначе удар бочки приходит вялой волной через треть секунды после звука.
      const rise = approach(0, 1);
      const fall = 1 - approach(1, 0);

      expect(rise).toBeGreaterThan(fall * 3);
    });

    it('приходит к цели и на ней остаётся', () => {
      let value = 0;
      for (let i = 0; i < 200; i++) value = approach(value, 0.6);

      expect(value).toBeCloseTo(0.6, 4);
      expect(approach(0.6, 0.6)).toBeCloseTo(0.6, 6);
    });

    it('тянет всю ленту и не выходит за более короткий массив', () => {
      const current = new Float32Array(4);
      const target = new Float32Array([1, 1]);

      expect(() => approachBands(current, target)).not.toThrow();
      expect(current[0]).toBeGreaterThan(0);
      expect(current[2]).toBe(0);
    });

    it('покой опознаётся и по уровням, и по ленте', () => {
      const quiet = bands();
      expect(isAtRest({ bass: 0, mid: 0, treble: 0 }, quiet)).toBe(true);

      const oneLoudBand = bands();
      oneLoudBand[7] = REST_EPSILON * 2;
      expect(isAtRest({ bass: 0, mid: 0, treble: 0 }, oneLoudBand)).toBe(false);
      expect(isAtRest({ bass: REST_EPSILON * 2, mid: 0, treble: 0 }, quiet)).toBe(false);
    });
  });

  describe('лента под углом', () => {
    it('зеркальна относительно вертикали', () => {
      const ribbon = bands();
      for (let i = 0; i < BAND_COUNT; i++) ribbon[i] = i / BAND_COUNT;

      expect(bandAt(ribbon, 0.25)).toBeCloseTo(bandAt(ribbon, 0.75), 6);
      expect(bandAt(ribbon, 0.1)).toBeCloseTo(bandAt(ribbon, 0.9), 6);
    });

    it('переливается между соседними полосами, а не прыгает ступенькой', () => {
      const ribbon = bands();
      ribbon[0] = 0;
      ribbon[1] = 1;

      const middle = bandAt(ribbon, 0.5 / (BAND_COUNT - 1) / 2);

      expect(middle).toBeGreaterThan(0);
      expect(middle).toBeLessThan(1);
    });

    it('заворачивает долю за пределами круга и не падает на пустой ленте', () => {
      const ribbon = bands();
      ribbon[3] = 0.5;

      expect(bandAt(ribbon, 1.25)).toBeCloseTo(bandAt(ribbon, 0.25), 6);
      expect(bandAt(ribbon, -0.75)).toBeCloseTo(bandAt(ribbon, 0.25), 6);
      expect(bandAt(new Float32Array(0), 0.4)).toBe(0);
    });
  });

  describe('палитра', () => {
    it('выводится из акцента приложения, а не задана заранее', () => {
      const cold = orbPalette('#8fd4ff', 'chill');
      const warm = orbPalette('#ffb38f', 'chill');

      expect(cold.core).not.toBe(warm.core);
    });

    it('настроение поворачивает акцент, а не подменяет его', () => {
      const accent = '#8fd4ff';
      const moods = Object.keys(MOOD_TINTS) as Array<keyof typeof MOOD_TINTS>;
      const cores = new Set(moods.map((mood) => orbPalette(accent, mood).core));

      // Пять настроений — пять разных цветов от одного акцента.
      expect(cores.size).toBe(moods.length);
    });

    it('отдаёт каналы числами 0–255 через запятую', () => {
      const palette = orbPalette('#8fd4ff', 'favorite');

      for (const value of Object.values(palette)) {
        const channels = value.split(', ').map(Number);
        expect(channels).toHaveLength(3);
        for (const channel of channels) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    });

    it('на мусоре вместо цвета берёт акцент по умолчанию', () => {
      expect(orbPalette('не цвет', 'chill')).toEqual(orbPalette(DEFAULT_ACCENT_HEX, 'chill'));
    });

    it('неизвестное настроение не оставляет шар без цвета', () => {
      const unknown = orbPalette('#8fd4ff', 'вальс' as never);

      expect(unknown).toEqual(orbPalette('#8fd4ff', 'chill'));
    });

    it('повторный запрос отдаёт тот же объект, а не собирает цвета заново', () => {
      expect(orbPalette('#8fd4ff', 'energy')).toBe(orbPalette('#8fd4ff', 'energy'));
    });

    it('на светлой теме шар не превращается в чёрное пятно', () => {
      /*
       * Здесь ломалось «на каждой теме отдельно эта штука ломается».
       *
       * Палитра не знала о глубине темы: провал в середине кольца оставался
       * почти чёрным и на белом окне читался дырой, пыль со светлотой
       * восемьдесят четыре исчезала, а пастельное кольцо сливалось с подложкой.
       */
      const dark = orbPalette(DEFAULT_ACCENT_HEX, 'chill', 'dusk');
      const light = orbPalette(DEFAULT_ACCENT_HEX, 'chill', 'light');
      const luma = (colour: string) => {
        const [r, g, b] = colour.split(', ').map(Number);
        return (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      };

      // Провал — это цвет окна: на тёмной теме почти чёрный, на светлой светлый.
      expect(luma(dark.deep)).toBeLessThan(0.2);
      expect(luma(light.deep)).toBeGreaterThan(0.8);
      // Пыль и кольцо на белом фоне видно только более плотными.
      expect(luma(light.dust)).toBeLessThan(luma(dark.dust));
      expect(luma(light.ring)).toBeLessThan(luma(dark.ring));
    });

    it('глубина темы входит в ключ кэша', () => {
      // Иначе смена темы отдавала бы цвета прошлой: кэш живёт всё время работы
      // приложения, а шар пересобирает палитру только при смене её входов.
      expect(orbPalette('#8fd4ff', 'focus', 'light')).not.toEqual(
        orbPalette('#8fd4ff', 'focus', 'night')
      );
    });

    it('без глубины ведёт себя как на теме по умолчанию', () => {
      // Шар рисуют и вне приложения — например, тесты и превью настроек, где
      // темы ещё нет. Третий довод необязателен именно поэтому.
      expect(orbPalette('#8fd4ff', 'chill')).toBe(orbPalette('#8fd4ff', 'chill', 'dusk'));
    });
  });

  describe('пыль на орбите', () => {
    it('раскладывается по всему кругу в заданных границах', () => {
      const dust = createDustRing(40);

      expect(dust).toHaveLength(40);
      expect(dust.some((particle) => Math.sin(particle.angle) > 0.5)).toBe(true);
      expect(dust.some((particle) => Math.sin(particle.angle) < -0.5)).toBe(true);
      for (const particle of dust) {
        expect(particle.orbit).toBeGreaterThanOrEqual(1.02);
        expect(particle.orbit).toBeLessThanOrEqual(1.62);
      }
    });

    it('высокие разгоняют пыль, но не сбивают её с орбиты', () => {
      const calm = createDustRing(6);
      const loud = calm.map((particle) => ({ ...particle }));

      advanceDust(calm, 0);
      advanceDust(loud, 1);

      for (let i = 0; i < calm.length; i++) {
        expect(Math.abs(loud[i].angle)).not.toBe(Math.abs(calm[i].angle));
        expect(loud[i].orbit).toBe(calm[i].orbit);
      }
    });
  });

  describe('ударные волны', () => {
    it('занимают свободные места, а затем вытесняют самую старую', () => {
      const pool = createShockPool(3);

      spawnShock(pool, 100, 1);
      spawnShock(pool, 200, 1);
      spawnShock(pool, 300, 1);
      expect(pool.map((shock) => shock.start)).toEqual([100, 200, 300]);

      spawnShock(pool, 400, 1);
      expect(pool).toHaveLength(3);
      expect(pool.map((shock) => shock.start)).toEqual([400, 200, 300]);
    });

    it('истаявшая волна освобождает место в пуле', () => {
      const pool = createShockPool(2);
      spawnShock(pool, 0, 1);

      const { ctx } = recorder();
      paintOrb(
        {
          ctx,
          centerX: 100,
          centerY: 100,
          radius: 40,
          clock: SHOCK_LIFE + 1,
          palette: orbPalette('#8fd4ff', 'chill'),
          levels: { bass: 0, mid: 0, treble: 0 },
          bands: bands()
        },
        [],
        pool
      );

      expect(pool[0].start).toBe(-1);
    });
  });

  describe('кадр', () => {
    const palette = orbPalette('#8fd4ff', 'energy');
    /** Так же, как считает компонент: половина стороны на самый дальний слой. */
    const halfSide = 160;
    const loud = { bass: 1, mid: 1, treble: 1 };

    function paintLoudFrame(clock: number) {
      const spectrum = bands();
      spectrum.fill(1);
      const dust = createDustRing(44);
      const shocks = createShockPool(5);
      for (let i = 0; i < 5; i++) spawnShock(shocks, clock - i * 220, 1);

      const canvas = recorder();
      paintOrb(
        {
          ctx: canvas.ctx,
          centerX: halfSide,
          centerY: halfSide,
          radius: (halfSide / MAX_REACH) * 0.98 * pulseScale(clock, loud.bass),
          clock,
          palette,
          levels: loud,
          bands: spectrum
        },
        dust,
        shocks
      );
      return canvas;
    }

    it('в покое пульсация ровно единица', () => {
      // Кадр покоя должен выглядеть одинаково при каждом входе на экран, а не
      // случайной фазой вздоха: часы в этот момент стоят на нуле.
      expect(pulseScale(0, 0)).toBe(1);
    });

    it('ни один слой не выходит за холст ни на одном возрасте волны', () => {
      // Обрезка прямым углом — самая заметная поломка шара: холст квадратный, и
      // всё, что вышло за половину стороны, превращается в ребро и цветной
      // обрывок сбоку.
      for (const clock of [0, 400, 900, 1600, 5000, 9000]) {
        const { arcs, points } = paintLoudFrame(clock);

        for (const arc of arcs) {
          const distance = Math.hypot(arc.x - halfSide, arc.y - halfSide);
          expect(distance + arc.r + arc.lineWidth / 2).toBeLessThanOrEqual(halfSide);
        }
        for (const point of points) {
          expect(Math.hypot(point.x - halfSide, point.y - halfSide)).toBeLessThanOrEqual(halfSide);
        }
      }
    });

    it('контуры ровные: соседние точки не прыгают, силуэт не погрызан', () => {
      /*
       * Это дословная запись жалобы «погрызанный пончик».
       *
       * Кольцо деформировалось двумя гармониками суммарно на семнадцать
       * процентов радиуса, и трёхдольная из них читалась не колыханием жидкости,
       * а тремя выеденными полукругами по краю. Проверяется ровно два числа:
       * скачок между соседними точками контура и размах всего контура. Первое
       * ловит зазубрины, второе — доли.
       */
      for (const clock of [0, 700, 3100]) {
        const { paths } = paintLoudFrame(clock);
        // Контуры — это пути с сотней с лишним точек; дуги, блики и пыль рисуются
        // через `arc` и в списке путей остаются пустыми.
        const contours = paths.filter((contour) => contour.length >= 64);
        expect(contours.length).toBeGreaterThanOrEqual(3);

        for (const contour of contours) {
          const radii = contour.map((point) => Math.hypot(point.x - halfSide, point.y - halfSide));
          const mean = radii.reduce((sum, r) => sum + r, 0) / radii.length;

          for (let i = 0; i < radii.length; i++) {
            const jump = Math.abs(radii[i] - radii[i === radii.length - 1 ? 0 : i + 1]);
            expect(jump / mean).toBeLessThan(0.03);
          }
          expect(Math.max(...radii) / Math.min(...radii)).toBeLessThan(1.2);
        }
      }
    });

    it('в холст не уходит ни одного нечисла и ни одного отрицательного радиуса', () => {
      const { numbers, arcs, radials } = paintLoudFrame(2500);

      expect(numbers.length).toBeGreaterThan(0);
      for (const value of numbers) expect(Number.isFinite(value)).toBe(true);
      for (const arc of arcs) expect(arc.r).toBeGreaterThanOrEqual(0);
      // Настоящий холст бросает IndexSizeError на отрицательном радиусе и на
      // внутреннем радиусе больше внешнего — это падение окна, не помарка.
      for (const radial of radials) {
        expect(radial.r0).toBeGreaterThanOrEqual(0);
        expect(radial.r1).toBeGreaterThanOrEqual(radial.r0);
      }
    });

    it('на выродившемся холсте рисует, но ничего не ломает', () => {
      const canvas = recorder();

      expect(() =>
        paintOrb(
          {
            ctx: canvas.ctx,
            centerX: 0,
            centerY: 0,
            radius: 0,
            clock: 0,
            palette,
            levels: { bass: 0, mid: 0, treble: 0 },
            bands: bands()
          },
          createDustRing(4),
          createShockPool(2)
        )
      ).not.toThrow();

      for (const value of canvas.numbers) expect(Number.isFinite(value)).toBe(true);
    });

    it('все цвета кадра собраны из палитры и с внятной прозрачностью', () => {
      const { stops } = paintLoudFrame(1200);

      expect(stops.length).toBeGreaterThan(10);
      for (const colour of stops) {
        const match = /^rgba\((\d+), (\d+), (\d+), (\d?\.?\d+)\)$/.exec(colour);
        expect(match, `цвет собран мимо палитры: ${colour}`).not.toBeNull();
        const alpha = Number(match?.[4]);
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThanOrEqual(1);
      }
    });
  });
});
