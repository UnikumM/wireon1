import { OrbPalette, SpectrumLevels, bandAt } from './orbEngine';

/**
 * Слои кадра шара «Потока».
 *
 * Компонент отвечает за то, когда рисовать и чем — за размер, часы и разобранный
 * звук. Здесь только то, как это выглядит: девять слоёв поверх друг друга.
 * Разделение нужно затем, чтобы облик шара можно было переписать, не касаясь
 * ни цикла кадров, ни правил остановки — а именно они в нём самое хрупкое.
 *
 * Ни один слой не задаёт своих цветов: всё приходит палитрой, которая выведена
 * из акцента приложения. Из холста нельзя достать `var(--accent)`, поэтому связь
 * с темой обеспечивает вызывающий, а не таблица стилей.
 */

/* ==========================================================================
   Границы слоёв

   Все расстояния — в долях радиуса кольца, ни одного числа в пикселях. Причина
   в том, что холст квадратный: всё, что выйдет за половину стороны, обрежется
   прямым углом, и на громком месте вокруг шара появляются рёбра. Радиус кольца
   считается делением половины стороны на самый дальний слой, поэтому этот
   список — не справка, а часть вычисления.
   ========================================================================== */

/** Пульсация кольца: дыхание в покое плюс вклад низа. */
const PULSE_BREATH = 0.045;
const PULSE_BASS = 0.14;
const PULSE_MAX = 1 + PULSE_BREATH + PULSE_BASS;

/** Рассеянное свечение вокруг кольца. */
const HALO_BASE = 1.4;
const HALO_BASS = 0.3;

/** Лента спектра: покой плюс разброс полос и гармоника. */
const RIBBON_BASE = 1.06;
/**
 * Разброс ленты от полос спектра.
 *
 * Было втрое больше. На громкой середине лента уходила от кольца почти на
 * половину радиуса, обгоняла орбиту пыли и сама себя перекрывала — на экране это
 * читалось не спектром, а клубком, из которого кольцо выглядывало кусками.
 */
const RIBBON_SPREAD = 0.18;
/** Во сколько раз разброс вырастает на самой громкой середине. */
const RIBBON_SPREAD_GAIN = 1.5;
const RIBBON_HARMONIC = 0.04;
/** Вторая лента шире первой — этим и видно, что их две. */
const RIBBON_OUTER_SCALE = 1.07;
/** Самая дальняя точка ленты в долях радиуса кольца. */
const RIBBON_MAX = RIBBON_OUTER_SCALE * (RIBBON_BASE + RIBBON_SPREAD * RIBBON_SPREAD_GAIN + RIBBON_HARMONIC);

/** Пыль на наклонной орбите. */
const DUST_ORBIT_MIN = 1.02;
const DUST_ORBIT_MAX = 1.62;
/** Наклон орбиты: во столько раз она ниже, чем шире. */
const DUST_TILT = 0.34;

/** Ударная волна: от кольца и наружу. */
const SHOCK_SPREAD = 1.05;
export const SHOCK_LIFE = 1100;

/**
 * Самый дальний слой в долях радиуса кольца.
 *
 * Пересчитывать при правке любой границы выше, иначе вернётся обрезка углами.
 */
export const MAX_REACH =
  PULSE_MAX * Math.max(HALO_BASE + HALO_BASS, RIBBON_MAX, DUST_ORBIT_MAX, 1 + SHOCK_SPREAD);

/* ==========================================================================
   Пыль на орбите
   ========================================================================== */

export interface Dust {
  /** Положение на орбите, радианы. */
  angle: number;
  /** Прирост угла за кадр; знак задаёт направление. */
  speed: number;
  /** Радиус орбиты в долях радиуса кольца. */
  orbit: number;
  /** Размер под кольцо радиуса 58 — дальше масштабируется вместе с ним. */
  size: number;
  /** Своя яркость: без разброса пыль выглядит рядом одинаковых точек. */
  alpha: number;
  /** Смещение орбиты по вертикали — иначе вся пыль лежит на одной линии. */
  lift: number;
  /** Сдвиг фазы мерцания. */
  twinkle: number;
}

/**
 * Пыль на наклонном кольце, а не облаком вокруг шара.
 *
 * Наклон даёт объём: половина орбиты проходит перед кольцом, половина за ним, и
 * шар перестаёт быть плоским кругом. Порядок отрисовки этим и определяется —
 * дальняя половина рисуется до кольца, ближняя после.
 */
export function createDustRing(count: number): Dust[] {
  const dust: Dust[] = [];
  for (let i = 0; i < count; i++) {
    dust.push({
      // Равномерный шаг плюс небольшой разброс: на чистом случайном распределении
      // пыль сбивается в комки и на орбите видны пустые дуги.
      angle: (i / count) * Math.PI * 2 + Math.random() * 0.18,
      speed: (0.0022 + Math.random() * 0.0034) * (Math.random() > 0.5 ? 1 : -1),
      orbit: DUST_ORBIT_MIN + Math.random() * (DUST_ORBIT_MAX - DUST_ORBIT_MIN),
      size: 0.9 + Math.random() * 1.9,
      alpha: 0.35 + Math.random() * 0.65,
      lift: (Math.random() - 0.5) * 0.16,
      twinkle: Math.random() * Math.PI * 2
    });
  }
  return dust;
}

/** Продвигает пыль по орбите. Высокие разгоняют её, но не разбрасывают. */
export function advanceDust(dust: Dust[], treble: number): void {
  const boost = 1 + treble * 2.4;
  for (const particle of dust) {
    particle.angle += particle.speed * boost;
  }
}

/* ==========================================================================
   Ударные волны
   ========================================================================== */

export interface Shock {
  /** Момент рождения по часам кадра; `-1` — место в пуле свободно. */
  start: number;
  /** Сила удара, от неё яркость и толщина. */
  strength: number;
}

export function createShockPool(count: number): Shock[] {
  const pool: Shock[] = [];
  for (let i = 0; i < count; i++) pool.push({ start: -1, strength: 0 });
  return pool;
}

/**
 * Кладёт новую волну в пул, вытесняя самую старую.
 *
 * Пул фиксированного размера, а не массив с добавлением: на плотной бочке волны
 * рождаются чаще, чем истаивают, и растущий массив к концу трека превращается в
 * сотни дуг за кадр. Вытеснение самой старой заметить нельзя — она к этому
 * моменту уже почти прозрачна.
 */
export function spawnShock(pool: Shock[], clock: number, strength: number): void {
  let oldest = 0;
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].start < 0) {
      pool[i].start = clock;
      pool[i].strength = strength;
      return;
    }
    if (pool[i].start < pool[oldest].start) oldest = i;
  }
  pool[oldest].start = clock;
  pool[oldest].strength = strength;
}

/* ==========================================================================
   Кадр
   ========================================================================== */

export interface OrbFrame {
  ctx: CanvasRenderingContext2D;
  centerX: number;
  centerY: number;
  /** Радиус кольца с уже учтённой пульсацией. */
  radius: number;
  /** Часы движения в миллисекундах; ноль означает покой. */
  clock: number;
  palette: OrbPalette;
  levels: SpectrumLevels;
  bands: Float32Array;
}

/** Сколько точек в контуре. Меньше сотни — на большом окне видны отрезки. */
const CONTOUR_POINTS = 128;

/**
 * Точки контура: считаются заранее, потому что сглаживание смотрит на пару.
 *
 * Массивы модульные, а не локальные: контуров в кадре три, кадров шестьдесят в
 * секунду, и триста шестьдесят выделений в секунду — работа для сборщика мусора
 * ровно там, где нельзя терять кадры. Ни один вызов не переживает свой кадр,
 * поэтому общий буфер здесь безопасен.
 */
const contourX = new Float64Array(CONTOUR_POINTS);
const contourY = new Float64Array(CONTOUR_POINTS);

/**
 * Замкнутый контур с радиусом, заданным функцией угла.
 *
 * Ломаной здесь больше нет. На ста двадцати восьми отрезках сама длина отрезка
 * незаметна, но заметен угол на каждом стыке: когда радиус между соседними
 * точками меняется, силуэт получает зазубрину, и вместо ровного кольца выходит
 * надкусанный пончик. Квадратичные кривые через середины отрезков убирают углы
 * целиком: точки контура становятся контрольными, а перья кривых сходятся в
 * серединах — там касательная у соседних кривых общая по построению.
 *
 * Побочное свойство важнее вида: кривая целиком лежит в выпуклой оболочке своих
 * контрольных точек, то есть контур не может уйти дальше самой дальней точки, а
 * значит не начнёт вылезать за холст.
 */
function traceContour(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radiusAt: (theta: number, t: number) => number
): void {
  for (let i = 0; i < CONTOUR_POINTS; i++) {
    const t = i / CONTOUR_POINTS;
    const theta = t * Math.PI * 2;
    const r = radiusAt(theta, t);
    contourX[i] = centerX + Math.cos(theta) * r;
    contourY[i] = centerY + Math.sin(theta) * r;
  }

  ctx.beginPath();
  // Начало — середина между последней и первой точкой. У замкнутой кривой стык
  // приходится сюда, и только в середине он невидим: начать с самой точки
  // значило бы оставить на контуре один угол, который на медленном вращении
  // кольца проезжает по кругу.
  const last = CONTOUR_POINTS - 1;
  ctx.moveTo((contourX[last] + contourX[0]) / 2, (contourY[last] + contourY[0]) / 2);
  for (let i = 0; i < CONTOUR_POINTS; i++) {
    const next = i === last ? 0 : i + 1;
    ctx.quadraticCurveTo(
      contourX[i],
      contourY[i],
      (contourX[i] + contourX[next]) / 2,
      (contourY[i] + contourY[next]) / 2
    );
  }
  ctx.closePath();
}

/** 1. Рассеянное свечение: то, что делает кольцо источником света, а не диском. */
function paintHalo(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, palette, levels } = frame;
  const outer = radius * (HALO_BASE + levels.bass * HALO_BASS);

  const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.55, centerX, centerY, outer);
  gradient.addColorStop(0, `rgba(${palette.halo}, ${(0.3 + levels.bass * 0.22).toFixed(3)})`);
  gradient.addColorStop(0.55, `rgba(${palette.ring}, 0.14)`);
  gradient.addColorStop(1, `rgba(${palette.ring}, 0)`);

  ctx.beginPath();
  ctx.arc(centerX, centerY, outer, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

/** 2. Ударные волны от удара по низу. */
function paintShocks(frame: OrbFrame, pool: Shock[]): void {
  const { ctx, centerX, centerY, radius, clock, palette } = frame;

  for (const shock of pool) {
    if (shock.start < 0) continue;
    const age = (clock - shock.start) / SHOCK_LIFE;
    if (age < 0 || age >= 1) {
      shock.start = -1;
      continue;
    }

    // Волна уходит замедляясь, а яркость падает квадратично: линейная выглядит
    // как гаснущая лампочка, а не как расходящийся по воде круг.
    const eased = 1 - (1 - age) * (1 - age);
    const ringRadius = radius * (1 + eased * SHOCK_SPREAD);
    const alpha = (1 - age) * (1 - age) * 0.5 * shock.strength;

    ctx.beginPath();
    ctx.arc(centerX, centerY, Math.max(0, ringRadius), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${palette.ring}, ${alpha.toFixed(3)})`;
    ctx.lineWidth = Math.max(0.6, radius * 0.03 * (1 - age));
    ctx.stroke();
  }
}

/** 3 и 9. Пыль. `front` выбирает половину орбиты — ближнюю или дальнюю. */
function paintDust(frame: OrbFrame, dust: Dust[], front: boolean): void {
  const { ctx, centerX, centerY, radius, clock, palette, levels } = frame;
  // Точки заданы под кольцо радиуса 58 и масштабируются вместе с ним: иначе на
  // большом окне это пыль, а на маленьком — горошины.
  const scale = radius / 58;

  for (const particle of dust) {
    const depth = Math.sin(particle.angle);
    if (front !== depth > 0) continue;

    const orbit = radius * particle.orbit * (1 + levels.treble * 0.22);
    const x = centerX + Math.cos(particle.angle) * orbit;
    const y = centerY + depth * orbit * DUST_TILT + radius * particle.lift;

    const twinkle = (Math.sin(clock * 0.0035 + particle.twinkle) + 1) / 2;
    // Дальняя половина тусклее ближней — этим и читается наклон орбиты.
    const depthFade = front ? 1 : 0.42;
    const alpha = Math.min(1, particle.alpha * (0.35 + twinkle * 0.5 + levels.treble * 0.45) * depthFade);
    const size = particle.size * scale * (1 + levels.treble * 0.6) * (front ? 1.15 : 0.85);

    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, size), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${palette.dust}, ${alpha.toFixed(3)})`;
    ctx.fill();
  }
}

/**
 * 4. Лента спектра — единственный слой, который показывает сам звук.
 *
 * Две ленты, вращающиеся навстречу: одна яркая, вторая тусклее и шире. На одной
 * рисунок читается плоским, на двух между ними появляется глубина, а точки их
 * пересечения бегут по кругу и создают движение, которого в самом звуке нет.
 */
function paintRibbons(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, clock, palette, levels, bands } = frame;
  // Доля разброса от середины. В покое лента почти прижата к кольцу — так видно,
  // что она отвечает на звук, а не висит вокруг постоянным ободом.
  const spread = RIBBON_SPREAD * (0.4 + levels.mid * (RIBBON_SPREAD_GAIN - 0.4));

  for (let layer = 0; layer < 2; layer++) {
    const direction = layer === 0 ? 1 : -1;
    const phase = clock * 0.00006 * direction;
    const scale = layer === 0 ? 1 : RIBBON_OUTER_SCALE;
    const alpha = layer === 0 ? 0.5 + levels.mid * 0.4 : 0.18 + levels.mid * 0.22;

    traceContour(ctx, centerX, centerY, (theta, t) => {
      const band = bandAt(bands, t + phase);
      const harmonic = Math.sin(theta * 5 + clock * 0.0016 * direction) * RIBBON_HARMONIC;
      return radius * scale * (RIBBON_BASE + band * spread + harmonic);
    });

    ctx.strokeStyle = `rgba(${palette.ring}, ${Math.min(1, alpha).toFixed(3)})`;
    ctx.lineWidth = Math.max(0.6, radius * (layer === 0 ? 0.022 : 0.012));
    ctx.stroke();
  }
}

/**
 * 5. Кольцо.
 *
 * Не шар: в середине провал, и сквозь него видна подложка окна. Так шар
 * перестаёт быть наклейкой поверх экрана — он часть его глубины.
 */
function paintRing(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, clock, palette, levels } = frame;

  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, Math.max(1, radius));
  gradient.addColorStop(0, `rgba(${palette.deep}, 0.12)`);
  gradient.addColorStop(0.38, `rgba(${palette.deep}, 0.6)`);
  gradient.addColorStop(0.58, `rgba(${palette.core}, ${(0.72 + levels.bass * 0.2).toFixed(3)})`);
  gradient.addColorStop(0.8, `rgba(${palette.ring}, 0.98)`);
  gradient.addColorStop(0.93, `rgba(${palette.core}, 0.82)`);
  gradient.addColorStop(1, `rgba(${palette.halo}, 0.28)`);

  // Две гармоники на разных скоростях: одна медленная и глубокая от низа,
  // вторая частая и мелкая от середины. По отдельности каждая выглядит
  // механической, вместе — как поверхность жидкости.
  //
  // Размах намеренно маленький, суммарно около шести процентов радиуса. На
  // прежних семнадцати трёхдольная гармоника читалась не колыханием, а тремя
  // выеденными полукругами: кольцо превращалось в надкусанный пончик, и никакое
  // сглаживание контура этого не лечило — форма была такой по замыслу.
  traceContour(ctx, centerX, centerY, (theta) => {
    const slow = Math.sin(theta * 3 + clock * 0.0011) * (0.012 + levels.bass * 0.03);
    const fast = Math.cos(theta * 7 - clock * 0.0019) * (0.006 + levels.mid * 0.016);
    return radius * (1 + slow + fast);
  });
  ctx.fillStyle = gradient;
  ctx.fill();
}

/** 6. Дымка в провале кольца: середина не должна быть просто дырой. */
function paintIris(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, palette, levels } = frame;
  const inner = Math.max(1, radius * 0.52);

  const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, inner);
  gradient.addColorStop(0, `rgba(${palette.ring}, ${(0.1 + levels.mid * 0.3).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(${palette.ring}, 0)`);

  ctx.beginPath();
  ctx.arc(centerX, centerY, inner, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
}

/**
 * 7. Постоянный блик сверху слева.
 *
 * Он не двигается вместе с музыкой нарочно: источник света в комнате один и
 * стоит на месте. Ровно этим отличается стекло от светящейся краски.
 */
function paintSpecular(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, palette } = frame;
  const arcRadius = Math.max(1, radius * 0.88);

  const gradient = ctx.createLinearGradient(
    centerX - arcRadius,
    centerY - arcRadius,
    centerX + arcRadius * 0.4,
    centerY + arcRadius * 0.2
  );
  gradient.addColorStop(0, `rgba(${palette.sheen}, 0)`);
  gradient.addColorStop(0.45, `rgba(${palette.sheen}, 0.55)`);
  gradient.addColorStop(1, `rgba(${palette.sheen}, 0)`);

  ctx.beginPath();
  ctx.arc(centerX, centerY, arcRadius, -2.55, -1.15);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = Math.max(1, radius * 0.1);
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * 8. Бегущий по кольцу отсвет.
 *
 * Медленный, один оборот за девять секунд: быстрее — и кольцо выглядит
 * вращающимся индикатором загрузки, а не жидким светом.
 */
function paintSweep(frame: OrbFrame): void {
  const { ctx, centerX, centerY, radius, clock, palette, levels } = frame;
  const arcRadius = Math.max(1, radius * 0.94);
  const from = (clock * 0.0007) % (Math.PI * 2);
  const to = from + 0.85;

  const gradient = ctx.createLinearGradient(
    centerX + Math.cos(from) * arcRadius,
    centerY + Math.sin(from) * arcRadius,
    centerX + Math.cos(to) * arcRadius,
    centerY + Math.sin(to) * arcRadius
  );
  gradient.addColorStop(0, `rgba(${palette.sheen}, 0)`);
  gradient.addColorStop(0.5, `rgba(${palette.sheen}, ${(0.22 + levels.treble * 0.3).toFixed(3)})`);
  gradient.addColorStop(1, `rgba(${palette.sheen}, 0)`);

  ctx.beginPath();
  ctx.arc(centerX, centerY, arcRadius, from, to);
  ctx.strokeStyle = gradient;
  ctx.lineWidth = Math.max(1, radius * 0.07);
  ctx.lineCap = 'round';
  ctx.stroke();
}

/**
 * Весь кадр, снизу вверх.
 *
 * Порядок здесь — единственное место, где он задан, и менять его надо целиком:
 * пыль дальней половины обязана лежать под кольцом, ближней — над ним, иначе
 * наклон орбиты пропадает и остаётся плоский круг с точками.
 */
export function paintOrb(frame: OrbFrame, dust: Dust[], shocks: Shock[]): void {
  paintHalo(frame);
  paintShocks(frame, shocks);
  paintDust(frame, dust, false);
  paintRibbons(frame);
  paintRing(frame);
  paintIris(frame);
  paintSpecular(frame);
  paintSweep(frame);
  paintDust(frame, dust, true);
}

/** Пульсация кольца: дыхание в покое плюс вклад низа. Ноль часов — ровно 1. */
export function pulseScale(clock: number, bass: number): number {
  return 1 + Math.sin(clock * 0.0016) * PULSE_BREATH + bass * PULSE_BASS;
}
