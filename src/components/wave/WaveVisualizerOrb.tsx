import React, { useEffect, useRef, useState } from 'react';
import { WaveMood } from '../../types/store';
import { audioEngine } from '../../services/audioEngine';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';
import { resolveAccentHex, useThemeStore } from '../../store/useThemeStore';
import { BAND_COUNT, approach, approachBands, isAtRest, orbPalette, readSpectrum } from './orbEngine';
import {
  Dust,
  MAX_REACH,
  Shock,
  advanceDust,
  createDustRing,
  createShockPool,
  paintOrb,
  pulseScale,
  spawnShock
} from './orbRenderer';

export interface WaveVisualizerOrbProps {
  mood?: WaveMood;
  isPlaying?: boolean;
  className?: string;
  style?: React.CSSProperties;
  width?: number;
  height?: number;
}

/** Сколько точек на орбите. Больше шестидесяти они сливаются в кольцо. */
const DUST_COUNT = 44;
/** Одновременно живущих ударных волн. */
const SHOCK_SLOTS = 5;

/** Ниже этого уровня удара нет — есть ровный гул. */
const SHOCK_FLOOR = 0.14;
/** Насколько резко должен подскочить низ, чтобы это читалось ударом. */
const SHOCK_JUMP = 0.045;
/** Чаще этого волны сливаются в кашу даже на очень плотном ритме. */
const SHOCK_COOLDOWN = 190;

/**
 * Кадр покоя — двадцать четыре в секунду вместо шестидесяти.
 *
 * Полная частота в покое слышна по вентилятору, но ноль кадров — хуже: шар
 * замирал в позе часов, остановленных на нуле, и это читалось не покоем, а
 * поломкой. При нуле пятая гармоника ленты складывает контур в правильный
 * пятиугольник, а блик стоит в одной точке — именно этот кадр и висел на экране
 * всё время, пока музыка не играет. Двадцать четыре кадра — порог, на котором
 * медленное вращение всё ещё слитное, а расход втрое меньше.
 */
const IDLE_FRAME_MS = 1000 / 24;

/**
 * Шар экрана «Поток».
 *
 * Кольцо света с наклонной орбитой пыли: середина прозрачная, сквозь неё видна
 * подложка окна. Цвет берётся из акцента приложения, а настроение волны
 * поворачивает его по кругу — так шар остаётся частью выбранной палитры, а не
 * единственным местом, которое живёт своими цветами.
 *
 * Шар дышит всегда, когда его видно: музыка задаёт удары, всплески и скорость
 * пыли, а без музыки остаются вращение, дыхание и блик — на четверти частоты.
 * Кадры прекращаются только там, где их некому смотреть: окно свёрнуто, шар ушёл
 * за край прокрутки или человек попросил систему убрать анимации.
 */
export const WaveVisualizerOrb: React.FC<WaveVisualizerOrbProps> = ({
  mood = 'chill',
  isPlaying = false,
  className = '',
  style = {},
  width = 320,
  height = 320
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameIdRef = useRef<number | null>(null);

  /**
   * Состояние картинки живёт в ref, а не в переменных эффекта.
   *
   * Пауза меняет `isPlaying`, эффект пересоздаётся — и всё, что было бы его
   * локальными переменными, обнулилось бы в этот момент. На экране это выглядит
   * так: шар схлопывается к покою одним кадром, а пыль прыгает в начальные
   * положения. В ref они переживают пересборку.
   */
  const dustRef = useRef<Dust[]>([]);
  const shocksRef = useRef<Shock[]>([]);
  const levelsRef = useRef({ bass: 0, mid: 0, treble: 0 });
  const bandsRef = useRef<Float32Array>(new Float32Array(BAND_COUNT));
  /** Разбор спектра пишет сюда, чтобы не выделять массив каждый кадр. */
  const rawBandsRef = useRef<Float32Array>(new Float32Array(BAND_COUNT));
  /** Уровень низа в прошлом кадре — по его скачку опознаётся удар. */
  const previousBassRef = useRef(0);
  const lastShockRef = useRef(Number.NEGATIVE_INFINITY);
  /** Когда последний раз рисовали. Нужно только для прореживания кадров покоя. */
  const lastPaintRef = useRef(Number.NEGATIVE_INFINITY);
  /** Размер холста в CSS-пикселях; обновляет ResizeObserver, а не каждый кадр. */
  const sizeRef = useRef({ width, height });

  const prefersReducedMotion = usePrefersReducedMotion();
  /**
   * Акцент приходит из хранилища темы, а не из `getComputedStyle`.
   *
   * Из холста переменную CSS не достать, а читать её вычисленный стиль каждый
   * кадр — это принудительный пересчёт раскладки шестьдесят раз в секунду.
   * Подписка отдаёт готовый hex и заново собирает палитру только когда акцент
   * действительно сменился.
   */
  const accentHex = useThemeStore((state) =>
    resolveAccentHex({ accentId: state.accentId, customAccentHex: state.customAccentHex })
  );
  /**
   * Глубина темы: от неё зависит светлота слоёв, а не только оттенок.
   *
   * Без неё шар был единственным местом приложения, которое рисовалось одними и
   * теми же числами на чёрном окне и на белом: в светлой теме середина кольца
   * оставалась тёмным пятном, а пыль и блик пропадали.
   */
  const themeDepth = useThemeStore((state) => state.depth);

  const [isPageVisible, setIsPageVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  );
  /**
   * Виден ли шар в прокрутке. По умолчанию да: без IntersectionObserver (jsdom,
   * старые webview) лучше рисовать, чем не рисовать никогда.
   */
  const [isOnScreen, setIsOnScreen] = useState(true);

  // Пыль и пул волн раскладываются один раз: их положения — это состояние
  // картинки, а не производное от пропов.
  useEffect(() => {
    dustRef.current = createDustRing(DUST_COUNT);
    shocksRef.current = createShockPool(SHOCK_SLOTS);
  }, []);

  // Свёрнутое окно — самый частый случай зря сожжённых кадров: шар продолжал
  // рисоваться в невидимый холст.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibility = () => setIsPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Прокрутили страницу так, что шар ушёл за край — рисовать тоже нечего.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setIsOnScreen(entry.isIntersecting);
      },
      // Небольшой запас, чтобы шар успел ожить до того, как покажется край.
      { rootMargin: '96px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * Разрешено ли движение вообще.
   *
   * `prefers-reduced-motion` гасит переходы в таблице стилей, но до цикла на
   * requestAnimationFrame ему не достать: человек, попросивший систему убрать
   * анимации, всё равно получал бы пульсирующий шар на весь экран.
   */
  const motionAllowed = isPageVisible && isOnScreen && !prefersReducedMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let destroyed = false;
    const palette = orbPalette(accentHex, mood, themeDepth);

    /**
     * Единственное место, где холст замеряется.
     *
     * `getBoundingClientRect` внутри кадра — это шестьдесят принудительных
     * пересчётов раскладки в секунду ради числа, которое меняется только вместе
     * с размером окна.
     */
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      sizeRef.current = {
        width: rect.width > 0 ? rect.width : width,
        height: rect.height > 0 ? rect.height : height
      };
    };
    measure();

    const render = (time: number) => {
      if (destroyed) return;
      frameIdRef.current = null;

      const levels = levelsRef.current;
      const bands = bandsRef.current;
      // Затухание после паузы — тоже движение: пока остаточная энергия не
      // истает, кадры нужны, иначе шар замирает на полувздохе.
      const wasAtRest = isAtRest(levels, bands);
      /** Есть ли что показывать по звуку: удары, всплески, скорость пыли. */
      const audioLive = motionAllowed && (isPlaying || !wasAtRest);

      /*
       * В покое кадры прореживаются, а не выключаются.
       *
       * Выход делается до всего остального — до замера, разбора спектра и
       * рисования, — иначе прореживание не экономит ничего: браузер всё равно
       * будит нас шестьдесят раз в секунду, и весь смысл в том, чтобы шестьдесят
       * раз ничего не делать вместо шестидесяти полных перерисовок.
       */
      if (motionAllowed && !audioLive && time - lastPaintRef.current < IDLE_FRAME_MS) {
        frameIdRef.current = requestAnimationFrame(render);
        return;
      }
      lastPaintRef.current = time;

      const displayWidth = sizeRef.current.width;
      const displayHeight = sizeRef.current.height;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const pixelWidth = Math.round(displayWidth * dpr);
      const pixelHeight = Math.round(displayHeight * dpr);

      // Присваивание размера холсту стирает его содержимое, поэтому только при
      // настоящем изменении.
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, displayWidth, displayHeight);

      // Спектр читается только во время игры: на паузе движок отдаёт последний
      // буфер, и шар «играл» бы дальше на замерших числах.
      const raw = readSpectrum(isPlaying ? audioEngine.getFrequencyData() : null, rawBandsRef.current);
      levels.bass = approach(levels.bass, raw.bass);
      levels.mid = approach(levels.mid, raw.mid);
      levels.treble = approach(levels.treble, raw.treble);
      approachBands(bands, rawBandsRef.current);

      /*
       * Часы кадра идут, пока движение разрешено, — и только тогда.
       *
       * Ноль здесь не «начало отсчёта», а поза для того случая, когда движения не
       * будет вовсе: `pulseScale` в нём даёт ровно единицу, блик стоит на месте,
       * лента разложена симметрично. Пока часы стояли ещё и на паузе, ровно эта
       * поза и была всем, что видно без музыки: пятая гармоника ленты складывала
       * контур в правильный пятиугольник, а бегущий блик замирал одной дугой.
       * Выглядело это не покоем, а недорисованной картинкой.
       */
      const clock = motionAllowed ? time : 0;

      const halfSide = Math.min(displayWidth, displayHeight) / 2;
      // Радиус выводится из самого дальнего слоя, а не задаётся сам: холст
      // квадратный, и всё, что выйдет за половину стороны, обрежется прямым
      // углом — на громком месте это видно как рёбра вокруг шара.
      const radius = (halfSide / MAX_REACH) * 0.98 * pulseScale(clock, levels.bass);

      if (audioLive) {
        // Удар опознаётся по скачку, а не по громкости: ровный гул на низах
        // держится высоко всё время, и по одному порогу волны рождались бы
        // каждый кадр.
        const jumped = levels.bass - previousBassRef.current > SHOCK_JUMP;
        if (levels.bass > SHOCK_FLOOR && jumped && clock - lastShockRef.current > SHOCK_COOLDOWN) {
          spawnShock(shocksRef.current, clock, Math.min(1, levels.bass * 1.5));
          lastShockRef.current = clock;
        }
      }
      // Пыль летит по орбите и без музыки — верх спектра только подгоняет её.
      // Замершее облако на вращающемся кольце выдаёт нарисованную картинку
      // вернее, чем любая другая деталь шара.
      if (motionAllowed) advanceDust(dustRef.current, levels.treble);
      previousBassRef.current = levels.bass;

      paintOrb(
        {
          ctx,
          centerX: displayWidth / 2,
          centerY: displayHeight / 2,
          radius,
          clock,
          palette,
          levels,
          bands
        },
        dustRef.current,
        shocksRef.current
      );

      ctx.restore();

      if (motionAllowed) {
        frameIdRef.current = requestAnimationFrame(render);
      }
    };

    /** Один кадр сейчас: либо начало цикла, либо статичная картинка покоя. */
    const schedule = () => {
      if (frameIdRef.current !== null) return;
      frameIdRef.current = requestAnimationFrame(render);
    };

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        measure();
        // Перерисовать надо и на паузе — иначе после смены размера окна на
        // экране остаётся растянутая картинка от прошлого замера.
        schedule();
      });
      observer.observe(canvas);
    }

    schedule();

    return () => {
      destroyed = true;
      observer?.disconnect();
      if (frameIdRef.current !== null) {
        cancelAnimationFrame(frameIdRef.current);
        frameIdRef.current = null;
      }
    };
  }, [accentHex, themeDepth, mood, isPlaying, motionAllowed, width, height]);

  return (
    <div
      ref={containerRef}
      className={className ? `wave-visualizer-container ${className}` : 'wave-visualizer-container'}
      style={{
        // Квадрат по доступной ширине: слои считаются от меньшей стороны, и на
        // вытянутом холсте половина площади просто пустовала бы. Жёсткой
        // минимальной ширины нет — в узком окне шар уменьшается, а не вылезает.
        position: 'relative',
        width: '100%',
        maxWidth: `${width}px`,
        aspectRatio: '1 / 1',
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style
      }}
      data-testid="wave-visualizer-orb"
    >
      <canvas ref={canvasRef} className="wave-orb-canvas" data-testid="wave-visualizer-canvas" />
    </div>
  );
};
