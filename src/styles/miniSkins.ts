import { CSSProperties } from 'react';

/**
 * Облики мини-плеера.
 *
 * Мини-плеер — отдельное окно 340×132 поверх всех остальных, и это единственная
 * часть приложения, которую видят, не глядя на неё: она висит в углу, пока
 * человек работает в другой программе. Отсюда и требования к обликам, не
 * совпадающие с полосой:
 *
 *   • разница между вариантами должна читаться с одного взгляда искоса, а не при
 *     сравнении. Поэтому меняется не только тон, но и размер с формой обложки —
 *     то, что в окне такого размера заметно первым;
 *
 *   • скругление окна выбирает облик, а не тема. Окно не прозрачное (в
 *     `electron/main.ts` у него сплошной `backgroundColor`), поэтому большой
 *     радиус оставляет в углах видимые уголки подложки — вариант с прямыми углами
 *     нужен как рабочий выбор, а не как нехватка вкуса.
 *
 * Разделение обязанностей — как у `playerSkins.ts` / `player.css`:
 *
 *   • здесь — переменные, которые окно подставляет себе в инлайновый стиль. Инлайн
 *     в этом проекте сильнее таблицы стилей, поэтому фон, рамку, радиус и размер
 *     обложки снаружи не переопределить: только через переменную, которую читает
 *     сам `MiniWindow.tsx`;
 *
 *   • в `mini.css` — характер: свечение, вращение обложки, приглушение подписей,
 *     затемнение поверх афиши. Всё цепляется за `data-mini-skin` на корне окна.
 */

/**
 * Переменные, которые мини-плеер читает в инлайновом стиле.
 *
 * Список закрытый: каждое имя обязано где-то подставляться, иначе облик «меняет»
 * то, чего никто не читает. Соответствие проверяется тестом.
 */
export const MINI_SKIN_VAR_NAMES = [
  '--mini-tint',
  '--mini-border',
  '--mini-radius',
  '--mini-shadow',
  '--mini-blur',
  '--mini-overlay',
  '--mini-artwork-size',
  '--mini-artwork-radius'
] as const;

export type MiniSkinVar = (typeof MINI_SKIN_VAR_NAMES)[number];

export type MiniSkinVars = Record<MiniSkinVar, string>;

export const MINI_SKIN_IDS = ['panel', 'glass', 'vinyl', 'neon', 'poster', 'hud'] as const;

export type MiniSkinId = (typeof MINI_SKIN_IDS)[number];

export const DEFAULT_MINI_SKIN_ID: MiniSkinId = 'panel';

export interface MiniSkin {
  id: MiniSkinId;
  /** Название для настроек. */
  name: string;
  /** Одна строка о том, чем облик отличается — её и читают при выборе. */
  hint: string;
  vars: MiniSkinVars;
}

export const MINI_SKINS: Record<MiniSkinId, MiniSkin> = {
  /**
   * Панель — то, чем мини-плеер был всегда: плотная плашка с рамкой.
   *
   * Значения повторяют сегодняшний вид до пикселя, поэтому облик по умолчанию
   * ничего не сдвигает у тех, кто настройку не открывал.
   */
  panel: {
    id: 'panel',
    name: 'Панель',
    hint: 'Плотная плашка с рамкой и небольшим скруглением',
    vars: {
      '--mini-tint': 'var(--surface-1)',
      '--mini-border': '1px solid var(--border)',
      '--mini-radius': 'var(--radius-md)',
      '--mini-shadow': 'none',
      '--mini-blur': 'none',
      '--mini-overlay': 'none',
      '--mini-artwork-size': '58px',
      '--mini-artwork-radius': 'var(--radius-sm)'
    }
  },

  /**
   * Стекло. Единственный облик, где сквозь окно видно то, что под ним, — а значит,
   * единственный, который можно оставить поверх текста, не закрывая его целиком.
   */
  glass: {
    id: 'glass',
    name: 'Стекло',
    hint: 'Полупрозрачное окно с размытием того, что под ним',
    vars: {
      '--mini-tint': 'var(--glass-bg-strong)',
      '--mini-border': '1px solid var(--glass-border)',
      '--mini-radius': 'var(--radius-lg)',
      '--mini-shadow': 'var(--glass-highlight)',
      '--mini-blur': 'var(--glass-blur)',
      // Блик по верхней кромке: у стекла край читается отражением, а не линией.
      // Тон берётся у washа наведения — он единственный, кто переворачивает
      // полярность вместе с темой, то есть светлеет на тёмной и темнеет на белой.
      '--mini-overlay': 'linear-gradient(180deg, var(--surface-active), transparent 45%)',
      '--mini-artwork-size': '58px',
      '--mini-artwork-radius': 'var(--radius-sm)'
    }
  },

  /**
   * Винил. Круглая обложка, которая вращается, пока идёт звук (`mini.css`).
   *
   * В окне размером с уведомление это единственный облик, по которому видно
   * состояние воспроизведения, не читая значков: крутится — значит играет.
   */
  vinyl: {
    id: 'vinyl',
    name: 'Винил',
    hint: 'Круглая обложка, вращается при звуке; тёплая панель',
    vars: {
      '--mini-tint': 'var(--surface-2)',
      '--mini-border': '1px solid var(--border-strong)',
      '--mini-radius': 'var(--radius-xl)',
      '--mini-shadow': 'var(--shadow-md)',
      '--mini-blur': 'none',
      '--mini-overlay': 'none',
      '--mini-artwork-size': '62px',
      '--mini-artwork-radius': 'var(--radius-full)'
    }
  },

  /**
   * Неон. Акцентная рамка и свечение вокруг окна.
   *
   * Смысл — заметность: окно поверх других легко потерять взглядом, и такой облик
   * находится мгновенно. Цвет берётся из акцента темы, поэтому «неон» остаётся
   * тем же цветом, что и всё приложение, а не вторым, спорящим с ним.
   */
  neon: {
    id: 'neon',
    name: 'Неон',
    hint: 'Акцентная рамка и свечение по контуру — окно видно сразу',
    vars: {
      '--mini-tint': 'var(--bg-base)',
      '--mini-border': '1px solid var(--border-accent)',
      '--mini-radius': 'var(--radius-md)',
      // Свечение собирается из акцентных токенов, а не из своего цвета: тонкий
      // контур — из бледного `--accent-soft`, дальний ореол — из более плотного
      // `--border-accent`, иначе на 14% альфы ореол не виден вовсе.
      '--mini-shadow': '0 0 0 1px var(--accent-soft), 0 8px 26px -6px var(--border-accent)',
      '--mini-blur': 'none',
      '--mini-overlay': 'radial-gradient(120% 80% at 50% 0%, var(--accent-soft), transparent 60%)',
      '--mini-artwork-size': '54px',
      '--mini-artwork-radius': 'var(--radius-sm)'
    }
  },

  /**
   * Афиша. Крупная квадратная обложка без скругления и без рамки.
   *
   * Обратный ход к остальным: не окно с картинкой внутри, а картинка, к которой
   * приделаны кнопки. Прямые углы здесь не «жёсткий стиль», а то, что квадратная
   * обложка вплотную к краю со скруглением окна выглядела бы обрезанной.
   */
  poster: {
    id: 'poster',
    name: 'Афиша',
    hint: 'Крупная квадратная обложка вплотную к краю, без рамки',
    vars: {
      '--mini-tint': 'var(--surface-sunken)',
      '--mini-border': 'none',
      '--mini-radius': '0',
      '--mini-shadow': 'none',
      '--mini-blur': 'none',
      // Затемнение снизу: подписи лежат рядом с крупной картинкой, и без него
      // светлая обложка съедала бы название. Готовый токен темы — тот же, которым
      // затемняют подписи поверх обложек во всём приложении.
      '--mini-overlay': 'var(--on-media-scrim)',
      '--mini-artwork-size': '76px',
      '--mini-artwork-radius': '0'
    }
  },

  /**
   * Индикатор. Самый тихий облик: скруглённая таблетка, мелкая круглая обложка,
   * ни рамки, ни тени.
   *
   * Для тех, кому мини-плеер нужен как строка состояния, а не как плеер. Радиус
   * во всю высоту, поэтому окно перестаёт читаться окном.
   */
  hud: {
    id: 'hud',
    name: 'Индикатор',
    hint: 'Таблетка без рамки с мелкой круглой обложкой — почти не мешает',
    vars: {
      '--mini-tint': 'var(--surface-sunken)',
      '--mini-border': 'none',
      '--mini-radius': 'var(--radius-full)',
      '--mini-shadow': 'none',
      '--mini-blur': 'none',
      '--mini-overlay': 'none',
      '--mini-artwork-size': '44px',
      '--mini-artwork-radius': 'var(--radius-full)'
    }
  }
};

/** Порядок в настройках: от привычного к самому непохожему. */
export const MINI_SKIN_LIST: readonly MiniSkin[] = MINI_SKIN_IDS.map((id) => MINI_SKINS[id]);

export function isMiniSkinId(value: unknown): value is MiniSkinId {
  return typeof value === 'string' && (MINI_SKIN_IDS as readonly string[]).includes(value);
}

/**
 * Переменные облика для инлайнового стиля окна.
 *
 * Неизвестный ключ отдаёт облик по умолчанию, а не пустой набор: значение
 * приходит из базы и по проводу между окнами, то есть из двух мест, где оно может
 * оказаться испорченным, — а пустой набор означал бы окно без фона и без обложки.
 */
export function miniSkinVars(id: MiniSkinId): CSSProperties {
  const skin = MINI_SKINS[id] ?? MINI_SKINS[DEFAULT_MINI_SKIN_ID];
  return skin.vars as CSSProperties;
}
