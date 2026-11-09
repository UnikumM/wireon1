/**
 * Слой движения: пять глаголов на всё приложение.
 *
 * До 4.0 анимации задавались в тридцати местах разными числами. Теперь любой
 * переход в интерфейсе — один из глаголов ниже, с одной кривой и длительностью
 * из короткой шкалы. Компоненты берут пресет по имени и не придумывают своих
 * чисел (за этим следит tests/unit/designDrift.test.ts).
 *
 *   появиться  (`appear`)  — списки, карточки, подсказки: снизу на 12 px из прозрачности;
 *   раскрыться (`island`)  — островок меняет форму: мини → полоса → сцена. Один и тот
 *                            же элемент через `layoutId`, без прозрачности;
 *   сменить    (`swap`)    — трек на трек, вкладка на вкладку: кроссфейд без сдвига;
 *   потянуть   (`pull`)    — шторки и плеер на телефоне идут за пальцем, отпускаются пружиной;
 *   отозваться (`respond`) — лайк, пауза, добавление: короткий импульс-подтверждение.
 *
 * Шестое — «ждать» — это скелетон, он живёт в CSS (`.skeleton`), ему JS не нужен.
 *
 * Длительности и кривые — те же, что в theme.css (`--dur-*`, `--ease-*`). Числа
 * здесь — значения по умолчанию: пресет оформления и ручка «Движение» меняют
 * токены во время работы, системное «меньше движения» схлопывает их до 1 мс, и
 * всё это учитывается тем, что длительность читается из документа (`readDuration`)
 * в момент запуска анимации, а не берётся константой. Согласованность чисел с
 * theme.css проверяет tests/unit/motion.test.ts.
 */
import type { Transition, Variants } from 'motion/react';

/**
 * Длительность ухода по умолчанию. Та же, что `--dur-fast`: JS держит уходящий
 * элемент в дереве ровно столько, сколько играют кадры CSS.
 */
export const EXIT_MS = 150;

/** Шкала длительностей (мс). Зеркало `--dur-*` в theme.css. */
export const DURATION = {
  fast: 150,
  normal: 220,
  slow: 320,
  morph: 620
} as const;

export type DurationName = keyof typeof DURATION;

/** Кривые. Зеркало `--ease-*` в theme.css, в виде, который понимает motion. */
export const EASE = {
  out: [0.16, 1, 0.3, 1],
  inOut: [0.65, 0, 0.35, 1],
  spring: [0.34, 1.6, 0.54, 1],
  morph: [0.2, 0.9, 0.24, 1]
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Сдвиг между соседями в списке при появлении, мс. */
export const STAGGER_MS = 30;

function rootElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Текущая длительность токена в миллисекундах.
 *
 * Из документа, а не из таблицы: пресет и ручка «Движение» переписывают
 * `--dur-*` на `<html>`, а системное «меньше движения» схлопывает их до 1 мс.
 * Константа этого не знала бы. Без документа (тесты, SSR) — значение по умолчанию.
 */
export function readDuration(name: DurationName): number {
  const el = rootElement();
  const fallback = DURATION[name];
  if (!el || typeof getComputedStyle !== 'function') return fallback;
  const raw = getComputedStyle(el).getPropertyValue(`--dur-${name}`).trim();
  if (!raw) return fallback;
  const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : NaN;
  if (!Number.isFinite(ms) || ms < 0) return fallback;
  return Math.max(1, Math.round(ms));
}

/** Секунды для motion из токена длительности. */
function seconds(name: DurationName): number {
  return readDuration(name) / 1000;
}

/**
 * Движение выключено человеком или системой.
 *
 * Пружины не читают `--dur-*`, поэтому при «меньше движения» их надо гасить
 * отдельно: `pull` и `island` в этом режиме становятся мгновенными.
 */
export function motionDisabled(): boolean {
  const el = rootElement();
  if (!el) return false;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  return readDuration('normal') <= 1;
}

/* -------------------------------------------------------------------------- */
/*  Глаголы                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Появиться. Для элемента или строки списка; `index` даёт ступенчатость.
 * Использование: `<motion.li {...appear(i)}>`.
 */
export function appear(index = 0) {
  return {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: 8 },
    transition: {
      duration: seconds('normal'),
      ease: EASE.out,
      delay: motionDisabled() ? 0 : (index * STAGGER_MS) / 1000
    } satisfies Transition
  };
}

/** Варианты «появиться» для `variants`/`AnimatePresence` со ступенчатыми детьми. */
export const appearVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  shown: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: seconds('normal'), ease: EASE.out, delay: motionDisabled() ? 0 : (index * STAGGER_MS) / 1000 }
  }),
  gone: { opacity: 0, y: 8, transition: { duration: seconds('fast'), ease: EASE.out } }
};

/**
 * Раскрыться. Переход `layout` для островка, который меняет форму. Ставится на
 * элемент с `layoutId`; при выключенном движении — мгновенно.
 */
export function island(): Transition {
  if (motionDisabled()) return { duration: 0 };
  return {
    type: 'spring',
    stiffness: 380,
    damping: 38,
    mass: 1,
    // Прозрачность островок не трогает: он один и тот же элемент, ему нечего проявлять.
    opacity: { duration: 0 }
  };
}

/** Сменить. Кроссфейд без сдвига; для `AnimatePresence mode="popLayout"` или `mode="wait"`. */
export function swap() {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: seconds('fast'), ease: EASE.out } satisfies Transition
  };
}

/**
 * Потянуть. Пружина, которой отпускается шторка или плеер после жеста.
 * Чуть мягче островка: после пальца резкость читается как рывок.
 */
export function pull(): Transition {
  if (motionDisabled()) return { duration: 0 };
  return { type: 'spring', stiffness: 300, damping: 30, mass: 0.9 };
}

/**
 * Отозваться. Импульс на действие: сердце, кнопка паузы, «добавлено».
 * Использование: `<motion.span animate={pressed ? 'on' : 'off'} variants={respondVariants}>`.
 */
export const respondVariants: Variants = {
  off: { scale: 1 },
  on: {
    scale: [0.6, 1.25, 1],
    transition: { duration: seconds('slow'), ease: EASE.out, times: [0, 0.6, 1] }
  }
};

/** Отозваться — как переход для `whileTap`. */
export const press = { scale: 0.96, transition: { duration: 0.12, ease: EASE.out } } as const;
