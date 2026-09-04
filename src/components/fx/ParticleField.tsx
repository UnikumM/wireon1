import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { type ParticleProfileId } from '../../styles/presets';

/**
 * Поле частиц под интерфейсом.
 *
 * Почему один холст, а не элементы с анимацией CSS. Двадцать движущихся `div`-ов —
 * это двадцать композиторных слоёв во всю площадь окна, которые браузер держит
 * постоянно; в «Буре» их девяносто. Холст — один слой и одна отрисовка на кадр,
 * причём её можно остановить, когда окно ушло в фон.
 *
 * Почему профиль приходит пропом, а не читается из `data-particles`. Атрибут пишет
 * `designService`, и он остаётся источником правды для CSS. Но компонент, который
 * сам читает документ, нельзя проверить без документа и он не узнаёт о смене
 * профиля — перерисовку ему всё равно приносит React. Проп делает и то, и другое
 * явным.
 *
 * Чего здесь нет намеренно:
 *
 *   `shadowBlur` — самый дорогой вызов 2D-контекста: каждая точка со свечением
 *   заставляет браузер размывать свой участок заново, и цена растёт с радиусом
 *   ореола. Свечение нарисовано один раз в спрайт и дальше только копируется
 *   (`drawImage`), поэтому частица стоит одинаково при любом размере;
 *
 *   `filter` и второй холст под следы — след получается частичным стиранием
 *   предыдущего кадра, то есть одной заливкой на кадр, а не размытием;
 *
 *   `setInterval` — шаг считается из времени, которое даёт `requestAnimationFrame`.
 *   Иначе на мониторе 144 Гц частицы летели бы вдвое быстрее, чем на 60.
 *
 * Геометрия слоя, порядок наложения и режим смешивания — в `src/styles/fx.css`.
 * Инлайном здесь не задаётся ничего: таблицу стилей инлайновый `style` перебивает,
 * и один такой атрибут отменил бы любую последующую правку оформления.
 */

export interface ParticleFieldProps {
  /** Что рисовать. `'off'` — не рисовать вовсе и не заводить кадры. */
  profile: ParticleProfileId;
  className?: string;
}

/** Профили, у которых есть что рисовать. */
type LiveProfile = Exclude<ParticleProfileId, 'off'>;

/** Из какого токена брать цвет. */
type Tint = 'accent' | 'faint';

type Rgb = readonly [number, number, number];

/** Диапазон значений: из него берётся случайное при рождении частицы. */
type Range = readonly [number, number];

interface ProfileSpec {
  /**
   * Плотность: частиц на миллион пикселей площади окна. Число, а не готовое
   * количество, — иначе на 4K поле выглядит пустым, а на маленьком окне забитым.
   */
  density: number;
  /** Границы количества до общего предела: профиль обязан оставаться собой. */
  min: number;
  max: number;
  /**
   * Сколько непрозрачности снимается с кадра перед отрисовкой. Ноль — кадр
   * стирается целиком и следов нет.
   */
  fade: number;
  /**
   * Радиус свечения целиком, а не яркой точки: в спрайте ярким остаётся примерно
   * четверть радиуса, остальное — затухающий ореол.
   */
  radius: Range;
  /** Скорость, CSS-пикселей в секунду. */
  speed: Range;
  /** Направление потока в радианах: 0 — вправо, π/2 — вниз. */
  angle: number;
  /** Разброс направления. Ноль — строго параллельный поток. */
  spread: number;
  /** Длина штриха в секундах движения. Ноль — только голова, без штриха. */
  streak: number;
  /** Толщина штриха. */
  line: number;
  alpha: Range;
  /** Боковое покачивание: амплитуда в пикселях в секунду и частота в герцах. */
  sway: number;
  swayHz: number;
  /** Какая доля непрозрачности дышит. Ноль — частица горит ровно. */
  twinkle: number;
  tint: Tint;
}

/**
 * Жёсткий предел, выше которого не поднимается ни один профиль.
 *
 * Дело не в самой отрисовке — девяносто копий спрайта дешёвы, — а в том, что поле
 * живёт под интерфейсом постоянно, в том числе на слабой встройке и на батарее.
 * Плотность «Бури» упирается в этот предел уже на обычном мониторе, и это нормально:
 * заметность даёт скорость и штрихи, а не счёт.
 */
const MAX_PARTICLES = 90;

const SPECS: Readonly<Record<LiveProfile, ProfileSpec>> = {
  /**
   * «Искры»: редкие точки со следами. Медленно всплывают, как угли над костром,
   * и слабо мерцают. Штрих короткий (полсекунды движения — около девяти пикселей):
   * он должен читаться как направление, а не как полоса.
   */
  sparks: {
    density: 22,
    min: 10,
    max: 34,
    fade: 0.085,
    radius: [3, 7],
    speed: [10, 26],
    angle: -Math.PI / 2,
    spread: 0.9,
    streak: 0.5,
    line: 0.9,
    alpha: [0.28, 0.72],
    sway: 7,
    swayHz: 0.09,
    twinkle: 0.5,
    tint: 'accent'
  },

  /**
   * «Дымка»: медленные крупные пятна на пределе видимости. Непрозрачность в
   * сотых долях не описка — пятно диаметром в двести пикселей при 0.1 читалось бы
   * как грязь на экране. Цвет нейтральный (`--text-faint`), а не акцентный:
   * дымка изображает глубину, а не подсветку.
   */
  mist: {
    density: 9,
    min: 5,
    max: 14,
    fade: 0,
    radius: [44, 118],
    speed: [3, 9],
    angle: -0.4,
    spread: 1.6,
    streak: 0,
    line: 1,
    alpha: [0.02, 0.05],
    sway: 16,
    swayHz: 0.035,
    twinkle: 0.35,
    tint: 'faint'
  },

  /**
   * «Струи»: тонкие вертикальные штрихи. Разброс направления почти нулевой —
   * дождь, который идёт вразнобой, выглядит сломанным. Мерцания нет: капля,
   * пролетающая окно за две секунды, не успевает подышать.
   */
  rain: {
    density: 34,
    min: 16,
    max: 52,
    fade: 0.26,
    radius: [1.6, 3.4],
    speed: [190, 420],
    angle: Math.PI / 2,
    spread: 0.05,
    streak: 0.055,
    line: 1,
    alpha: [0.14, 0.36],
    sway: 0,
    swayHz: 0,
    twinkle: 0,
    tint: 'accent'
  },

  /**
   * «Буря»: плотный поток под ветром. Наклон и разброс больше, чем у струй, —
   * поток должен читаться как порыв, а не как ровный дождь. Плотность заведомо
   * упирается в `MAX_PARTICLES`.
   */
  storm: {
    density: 68,
    min: 34,
    max: 90,
    fade: 0.16,
    radius: [2, 5],
    speed: [110, 320],
    angle: Math.PI / 2 - 0.34,
    spread: 0.3,
    streak: 0.05,
    line: 1.1,
    alpha: [0.16, 0.5],
    sway: 4,
    swayHz: 0.22,
    twinkle: 0.3,
    tint: 'accent'
  }
};

const TINT_VARS: Readonly<Record<Tint, string>> = {
  accent: '--accent',
  faint: '--text-faint'
};

/**
 * Запасные цвета — ровно те, что объявлены в `:root` у theme.css.
 *
 * Нужны не для красоты: переменная читается из документа, а вернуть она может
 * пустую строку — в первом кадре до применения оформления, в тестовой среде без
 * таблицы стилей, в мини-окне со своим документом. Без запаса `fillStyle` получил
 * бы `rgb(NaN, NaN, NaN)` и поле молча осталось бы пустым.
 */
const FALLBACK_RGB: Readonly<Record<Tint, Rgb>> = {
  accent: [65, 158, 251],
  faint: [107, 112, 123]
};

/**
 * Сторона спрайта свечения. 64 — компромисс: мельче видны ступени градиента на
 * крупных пятнах «Дымки», крупнее нет смысла, потому что спрайт всё равно
 * растягивается под радиус частицы.
 */
const SPRITE_SIZE = 64;

/**
 * Как часто перечитывается цвет, в секундах.
 *
 * Акцент меняется в настройках, и частицы обязаны сменить цвет вместе с ним, но
 * `getComputedStyle` в каждом кадре — это принудительный пересчёт стилей шестьдесят
 * раз в секунду ради значения, которое меняется раз в месяц. Раз в секунду
 * незаметно на глаз и бесплатно по цене.
 */
const COLOR_REFRESH_SEC = 1;

/**
 * Предел шага, секунды.
 *
 * После возврата из фона или просадки кадра дельта бывает в сотни миллисекунд, и
 * без предела весь поток скакнул бы через пол-окна одним кадром.
 */
const MAX_STEP_SEC = 0.05;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  /** Фаза покачивания и мерцания: у каждой своя, иначе поле дышит стробоскопом. */
  phase: number;
  /** Скорость набора фазы, радиан в секунду. */
  pulse: number;
}

function pick([from, to]: Range): number {
  return from + Math.random() * (to - from);
}

/** Сколько частиц держать на окне такой площади. */
function targetCount(spec: ProfileSpec, width: number, height: number): number {
  const megapixels = (width * height) / 1_000_000;
  const cap = Math.min(spec.max, MAX_PARTICLES);
  return Math.min(cap, Math.max(spec.min, Math.round(spec.density * megapixels)));
}

function spawn(spec: ProfileSpec, width: number, height: number): Particle {
  const angle = spec.angle + (Math.random() - 0.5) * spec.spread;
  const speed = pick(spec.speed);
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius: pick(spec.radius),
    alpha: pick(spec.alpha),
    phase: Math.random() * Math.PI * 2,
    // Частота у каждой частицы своя, с разбросом ±40% от профиля: одинаковая даёт
    // видимый ритм на всём поле.
    pulse: spec.swayHz * (0.6 + Math.random() * 0.8) * Math.PI * 2
  };
}

/**
 * Возвращает ушедшую за край частицу с противоположной стороны.
 *
 * Не пересоздаёт её: новая частица получила бы новую скорость и новый радиус, и
 * поле заметно «дёргалось» бы у краёв. Запас на радиус нужен, чтобы пятно
 * появлялось из-за края, а не возникало посреди экрана.
 */
function wrap(particle: Particle, width: number, height: number): void {
  const margin = particle.radius + 2;
  const spanX = width + margin * 2;
  const spanY = height + margin * 2;
  // Остаток от деления, а не цикл `while`: при большом шаге цикл прокрутился бы
  // много раз, а результат тот же.
  particle.x = ((((particle.x + margin) % spanX) + spanX) % spanX) - margin;
  particle.y = ((((particle.y + margin) % spanY) + spanY) % spanY) - margin;
}

/** Разбирает `#rgb`, `#rrggbb` и любую запись через каналы (`rgb()`, `rgba()`). */
function parseRgb(raw: string): Rgb | null {
  if (raw.startsWith('#')) {
    const digits = raw.slice(1);
    const full = digits.length === 3 ? digits.replace(/./g, (char) => char + char) : digits;
    if (full.length < 6) return null;
    const packed = Number.parseInt(full.slice(0, 6), 16);
    return Number.isNaN(packed) ? null : [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
  }

  const channels = raw.match(/-?\d*\.?\d+/g);
  if (!channels || channels.length < 3) return null;
  return [Number(channels[0]), Number(channels[1]), Number(channels[2])];
}

/** Текущий цвет из документа. Читается, а не задаётся, чтобы жить вместе с темой. */
function readTint(tint: Tint): Rgb {
  const fallback = FALLBACK_RGB[tint];
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback;

  const raw = getComputedStyle(document.documentElement).getPropertyValue(TINT_VARS[tint]).trim();
  return parseRgb(raw) ?? fallback;
}

/**
 * Спрайт свечения: мягкое пятно, растянутое под радиус частицы.
 *
 * Это замена `shadowBlur`. Градиент считается один раз на смену цвета, дальше
 * частица стоит один `drawImage` — столько же, сколько плоский круг, но выглядит
 * как источник света, а не как наклейка.
 */
function makeSprite([red, green, blue]: Rgb): HTMLCanvasElement | null {
  const sprite = document.createElement('canvas');
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;

  const ctx = sprite.getContext('2d');
  if (!ctx) return null;

  const half = SPRITE_SIZE / 2;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  // Остановки подобраны так, чтобы ядро осталось маленьким и плотным: плавный
  // градиент от центра к краю даёт ватный шарик, а не искру.
  glow.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 1)`);
  glow.addColorStop(0.22, `rgba(${red}, ${green}, ${blue}, 0.6)`);
  glow.addColorStop(0.55, `rgba(${red}, ${green}, ${blue}, 0.15)`);
  glow.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);

  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return sprite;
}

/** Голова частицы. Без спрайта — плоское ядро: хуже, но лучше, чем пустое поле. */
function drawHead(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement | null,
  x: number,
  y: number,
  radius: number
): void {
  if (sprite) {
    ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
    return;
  }

  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, radius * 0.25), 0, Math.PI * 2);
  ctx.fill();
}

export function ParticleField({ profile, className }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /**
   * Системная просьба убрать движение выражена медиазапросом, и цикл на
   * `requestAnimationFrame` ему не подчиняется сам: гасить движение обязан код.
   */
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // Выключенный профиль не рендерит холст, так что сюда мы попадаем только при
    // живом профиле. Проверка стоит первой ещё и затем, чтобы `SPECS[profile]`
    // ниже был типизирован без приведений.
    if (profile === 'off') return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const spec = SPECS[profile];
    const particles: Particle[] = [];
    /** Размер холста в CSS-пикселях: физический буфер вдвое-втрое больше. */
    let width = 0;
    let height = 0;
    let sprite: HTMLCanvasElement | null = null;
    /** Плоский цвет для штрихов и для запасной отрисовки без спрайта. */
    let solid = '';
    let frame: number | null = null;
    /** Метка предыдущего кадра. `null` — шаг считать не от чего, дельта нулевая. */
    let previous: number | null = null;
    let colorClock = 0;

    const refreshColor = (): void => {
      const rgb = readTint(spec.tint);
      const next = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      // Спрайт перерисовывается только на смену цвета: он и есть вся его цена.
      if (next === solid) return;
      solid = next;
      sprite = makeSprite(rgb);
    };

    /** Держит количество под площадь окна: окно выросло — досыпаем, а не начинаем заново. */
    const syncCount = (): void => {
      const target = targetCount(spec, width, height);
      while (particles.length > target) particles.pop();
      while (particles.length < target) particles.push(spawn(spec, width, height));
    };

    /**
     * Пересборка буфера.
     *
     * Буфер держится в физических пикселях, а контекст масштабируется: на 150%
     * масштабе Windows холст в CSS-пикселях растягивается системой, и вместо
     * искры получается мыльное пятно. Матрица ставится именно здесь — присвоение
     * `canvas.width` сбрасывает её вместе с содержимым.
     */
    const measure = (): void => {
      const dpr = window.devicePixelRatio || 1;
      /**
       * Размер берётся у окна, а не у самого холста: `clientWidth` холста следует
       * за его CSS-размером только пока подключён fx.css, а без таблицы стилей —
       * за собственным буфером, и тот распухал бы кратно масштабу экрана на каждом
       * измерении. `documentElement.clientWidth` — ровно та область, в которую
       * растянут слой с `position: fixed; inset: 0`; `innerWidth` остаётся на
       * случай, когда раскладки нет вовсе.
       */
      width = document.documentElement.clientWidth || window.innerWidth;
      height = document.documentElement.clientHeight || window.innerHeight;

      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      syncCount();
    };

    const draw = (step: number): void => {
      if (spec.fade > 0) {
        // След — частичным стиранием кадра, а не заливкой цветом фона: холст обязан
        // остаться прозрачным, иначе он закроет собой всё окно. `destination-out`
        // снимает долю непрозрачности с того, что уже нарисовано.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(0, 0, 0, ${spec.fade})`;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.clearRect(0, 0, width, height);
      }

      // Стиль ставится один раз на кадр, а прозрачность отдельной частицы — через
      // `globalAlpha`. Собирать `rgba(...)` на каждую частицу значит строить до
      // девяноста строк в кадре ради чисел, известных заранее.
      ctx.fillStyle = solid;
      ctx.strokeStyle = solid;
      ctx.lineWidth = spec.line;
      ctx.lineCap = 'round';

      for (const particle of particles) {
        particle.phase += particle.pulse * step;
        particle.x += (particle.vx + Math.sin(particle.phase) * spec.sway) * step;
        particle.y += particle.vy * step;
        wrap(particle, width, height);

        // Множитель 1.7 разводит мерцание с покачиванием: на одной фазе частица
        // гаснет ровно в крайних точках качания, и движение выглядит механическим.
        const alpha = particle.alpha * (1 - spec.twinkle * (0.5 + 0.5 * Math.sin(particle.phase * 1.7)));

        if (spec.streak > 0) {
          ctx.globalAlpha = alpha * 0.42;
          ctx.beginPath();
          ctx.moveTo(particle.x - particle.vx * spec.streak, particle.y - particle.vy * spec.streak);
          ctx.lineTo(particle.x, particle.y);
          ctx.stroke();
        }

        ctx.globalAlpha = alpha;
        drawHead(ctx, sprite, particle.x, particle.y, particle.radius);
      }

      ctx.globalAlpha = 1;
    };

    const tick = (time: number): void => {
      frame = null;

      const step = previous === null ? 0 : Math.min(MAX_STEP_SEC, (time - previous) / 1000);
      previous = time;

      colorClock += step;
      if (colorClock >= COLOR_REFRESH_SEC) {
        colorClock = 0;
        refreshColor();
      }

      draw(step);
      frame = requestAnimationFrame(tick);
    };

    const stop = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      // Следующий шаг считается заново: иначе после возврата из фона дельта была бы
      // равна времени, проведённому в фоне.
      previous = null;
    };

    const start = (): void => {
      if (frame !== null || document.hidden) return;
      previous = null;
      frame = requestAnimationFrame(tick);
    };

    const onResize = (): void => {
      measure();
      // В цикле следующий кадр перерисует всё сам, а статичный кадр — нет, и после
      // растягивания окна остался бы пустой холст.
      if (prefersReducedMotion) draw(0);
    };

    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };

    refreshColor();
    measure();
    window.addEventListener('resize', onResize);

    if (prefersReducedMotion) {
      // Один кадр и ни одного больше: просивший убрать движение получает фон, а не
      // пустоту на месте фона.
      draw(0);
    } else {
      // Фоновое окно не должно жечь GPU: свёрнутое приложение — самый частый случай
      // кадров, нарисованных в никуда.
      document.addEventListener('visibilitychange', onVisibility);
      start();
    }

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [profile, prefersReducedMotion]);

  // Ни холста, ни кадров: выключенный профиль не должен стоить даже одного
  // элемента в дереве.
  if (profile === 'off') return null;

  return (
    <canvas
      ref={canvasRef}
      className={className ? `particle-field ${className}` : 'particle-field'}
      // Слой чисто декоративный: в дереве доступности его быть не должно, а
      // нажатия обязаны проходить сквозь него к интерфейсу (`pointer-events` в CSS).
      aria-hidden="true"
      data-profile={profile}
      data-testid="particle-field"
    />
  );
}
