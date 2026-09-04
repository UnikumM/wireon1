import { CSSProperties } from 'react';

/**
 * Облики полосы плеера.
 *
 * Плотность и набор кнопок отвечают на вопрос «сколько и чего», облик — на
 * вопрос «чем это вообще является»: полосой во всю ширину, парящей таблеткой,
 * стеклом, тонкой линией, пультом. Разница между обликами нарочно грубая: если
 * два варианта нужно сравнивать, разглядывая пиксели, выбор из них никому не
 * нужен.
 *
 * Разделение обязанностей ровно такое же, как во всём проекте:
 *
 *   • здесь — переменные, которые полоса подставляет себе в инлайновый стиль.
 *     Инлайн в этом проекте сильнее таблицы стилей, поэтому всё, что задано в
 *     `PlayerBar.tsx` напрямую (фон, радиус, отступы от краёв, высота), нельзя
 *     переопределить снаружи — только через переменную, которую он же и читает;
 *
 *   • в `player.css` — характер: свечение, тени, украшения, поворот обложки,
 *     порядок зон. Всё это цепляется за `data-player-skin` на самой полосе.
 *
 * Значения по умолчанию для всех переменных лежат в `player.css`, поэтому полоса
 * остаётся собранной, даже если облик не выбран вовсе.
 */

/**
 * Переменные, которые полоса читает в инлайновом стиле.
 *
 * Список закрытый: каждое имя ниже обязано где-то подставляться, иначе облик
 * «меняет» то, чего никто не читает. Соответствие проверяется тестом.
 */
export const PLAYER_SKIN_VAR_NAMES = [
  '--player-surface',
  '--player-border-top',
  '--player-radius',
  '--player-inset',
  '--player-lift',
  '--player-height',
  '--player-shadow',
  '--player-blur'
] as const;

export type PlayerSkinVar = (typeof PLAYER_SKIN_VAR_NAMES)[number];

export type PlayerSkinVars = Record<PlayerSkinVar, string>;

export const PLAYER_SKIN_IDS = ['bar', 'float', 'glass', 'line', 'vinyl', 'deck', 'card'] as const;

export type PlayerSkinId = (typeof PLAYER_SKIN_IDS)[number];

export const DEFAULT_PLAYER_SKIN_ID: PlayerSkinId = 'bar';

export interface PlayerSkin {
  id: PlayerSkinId;
  /** Название для настроек. */
  name: string;
  /** Одна строка о том, чем этот облик отличается — её и читают при выборе. */
  hint: string;
  /**
   * Сжатый ряд транспорта.
   *
   * Здесь ломалась «Парящая»: облик отнимал высоту у полосы, а содержимое об этом
   * не знало. Ряд транспорта в баре — это кнопка 48 px, зазор 8 px и таймлайн
   * 16 px, то есть 72 px, и в таблетке высотой 54 px (пресет «Обсидиан» отдаёт
   * полосе 78 px) кнопка с таймлайном выходили за скруглённый контур сверху и
   * снизу. Отсюда правило: облик, отдавший высоту, обязан сжать и содержимое —
   * ступенькой ниже по той же шкале `--control-*` / `ICON`, то есть до 64 px.
   *
   * Размеры глифов у lucide — числовой проп, переменной CSS их не подменить,
   * поэтому это поле, а не девятая переменная в наборе выше.
   */
  tightControls: boolean;
  vars: PlayerSkinVars;
}

/**
 * Высота полосы приходит из пресета приложения (`--player-bar-height`), и облик
 * её не подменяет: место под плеер приложение уже зарезервировало, и полоса,
 * ставшая выше, легла бы на содержимое.
 *
 * Стать *ниже* облик может, но ровно настолько, насколько содержимое согласно
 * сжаться. Сжатый ряд транспорта занимает 64 px, самый низкий пресет отдаёт
 * полосе 78 px — отсюда потолок отступа в 8–12 px и `tightControls` у всех, кто
 * его берёт. Именно так и получается парящая таблетка: не сдвигом раскладки, а
 * внутри уже отданного ей пространства.
 */
const FULL_HEIGHT = 'var(--player-bar-height)';

export const PLAYER_SKINS: Record<PlayerSkinId, PlayerSkin> = {
  /** Полоса во всю ширину — то, чем плеер был всегда. */
  bar: {
    id: 'bar',
    name: 'Полоса',
    hint: 'Плотная полоса во всю ширину окна с тонкой чертой сверху',
    tightControls: false,
    vars: {
      '--player-surface': 'var(--surface-1)',
      '--player-border-top': '1px solid var(--border-subtle)',
      '--player-radius': '0',
      '--player-inset': '0px',
      '--player-lift': '0px',
      '--player-height': FULL_HEIGHT,
      '--player-shadow': 'none',
      '--player-blur': 'none'
    }
  },

  /**
   * Парящая таблетка. Отступ от краёв и тень — единственное, что отличает
   * предмет, лежащий на экране, от края самого экрана.
   */
  float: {
    id: 'float',
    name: 'Парящая',
    hint: 'Таблетка с отступом от краёв, на глубокой тени',
    // Единственный облик, оторванный от края со всех четырёх сторон, — и потому
    // единственный, где вылезшая за контур кнопка читается поломкой, а не
    // плотной вёрсткой.
    tightControls: true,
    vars: {
      '--player-surface': 'var(--surface-2)',
      // Черта сверху не нужна: у предмета, оторванного от края, есть свой контур
      // по всему периметру, и линия только сверху выглядела бы обломком полосы.
      '--player-border-top': 'none',
      '--player-radius': 'var(--radius-xl)',
      '--player-inset': 'var(--space-5)',
      '--player-lift': 'var(--space-4)',
      // Ниже отданной полосы, но всего на восемь пикселей: сверху и снизу нужен
      // воздух, иначе «парящая» упирается в содержимое и в край окна
      // одновременно, — а больше отнять нельзя. Пресет «Обсидиан» отдаёт полосе
      // 78 px, сжатый ряд транспорта занимает 64 px, и прежние 24 px оставляли
      // таблетку в 54 px: кнопка и таймлайн выходили за скруглённый контур.
      '--player-height': 'calc(var(--player-bar-height) - var(--space-2))',
      '--player-shadow': 'var(--shadow-lg), var(--ring-1) var(--border-strong)',
      '--player-blur': 'none'
    }
  },

  /**
   * Стекло. Работает только при размытии подложки: без него это просто полупрозрачный
   * прямоугольник, сквозь который читается текст под ним.
   */
  glass: {
    id: 'glass',
    name: 'Стекло',
    hint: 'Полупрозрачная полоса с размытием того, что под ней',
    tightControls: false,
    vars: {
      '--player-surface': 'var(--glass-bg-strong)',
      '--player-border-top': '1px solid var(--glass-border)',
      '--player-radius': '0',
      '--player-inset': '0px',
      '--player-lift': '0px',
      '--player-height': FULL_HEIGHT,
      '--player-shadow': 'var(--glass-highlight)',
      '--player-blur': 'var(--glass-blur)'
    }
  },

  /**
   * Линия. Ни поверхности, ни рамки — только содержимое над подложкой окна.
   *
   * Самый спорный облик и потому самый нужный: кому-то плеер мешает, и такой
   * человек скорее выключит его совсем, чем оставит панель на четверть экрана.
   */
  line: {
    id: 'line',
    name: 'Линия',
    hint: 'Без поверхности: только обложка, название и кнопки над окном',
    // Смысл облика — «плеер почти не мешает». Крупный ряд транспорта в нём
    // противоречил бы сам себе.
    tightControls: true,
    vars: {
      '--player-surface': 'transparent',
      '--player-border-top': 'none',
      '--player-radius': '0',
      '--player-inset': 'var(--space-4)',
      '--player-lift': '0px',
      // Прежние 32 px оставляли размытие подложки меньше самого содержимого:
      // название трека ложилось на список мимо размытой области.
      '--player-height': 'calc(var(--player-bar-height) - var(--space-2))',
      '--player-shadow': 'none',
      // Размытие здесь важнее, чем у «Стекла»: поверхности нет вообще, и без него
      // название трека ложится прямо на список под плеером.
      '--player-blur': 'var(--glass-blur)'
    }
  },

  /**
   * Винил. Круглая обложка, которая вращается, пока идёт звук.
   *
   * Единственный облик, где движение привязано к воспроизведению, а не к
   * наведению: пластинка, стоящая на месте при играющем звуке, читается ошибкой.
   */
  vinyl: {
    id: 'vinyl',
    name: 'Винил',
    hint: 'Тёплая панель с круглой обложкой, вращающейся при звуке',
    tightControls: false,
    vars: {
      '--player-surface': 'var(--surface-2)',
      '--player-border-top': '1px solid var(--border-strong)',
      '--player-radius': '0',
      '--player-inset': '0px',
      '--player-lift': '0px',
      '--player-height': FULL_HEIGHT,
      '--player-shadow': 'var(--glass-highlight)',
      '--player-blur': 'none'
    }
  },

  /**
   * Пульт. Прямые углы, плотная сетка, вдавленная поверхность.
   *
   * Отсылка к студийному железу: там ничего не скруглено, потому что панель
   * фрезеруют, а не рисуют.
   */
  deck: {
    id: 'deck',
    name: 'Пульт',
    hint: 'Прямые углы, вдавленная панель, крупные цифры времени',
    tightControls: false,
    vars: {
      '--player-surface': 'var(--surface-sunken)',
      '--player-border-top': '1px solid var(--border-strong)',
      '--player-radius': '0',
      '--player-inset': '0px',
      '--player-lift': '0px',
      '--player-height': FULL_HEIGHT,
      '--player-shadow': 'inset 0 2px 6px rgb(0 0 0 / 0.45)',
      '--player-blur': 'none'
    }
  },

  /**
   * Карточка. Приподнятая плашка с акцентным торцом слева.
   *
   * Отличается от «Парящей» тем, что прижата к низу: это не предмет в воздухе, а
   * выдвинутый снизу ящик.
   */
  card: {
    id: 'card',
    name: 'Карточка',
    hint: 'Приподнятая плашка со скруглением сверху и акцентным торцом',
    // Скругление только сверху, но полоса всё равно ниже отданной — значит, и
    // здесь содержимое обязано в неё уложиться.
    tightControls: true,
    vars: {
      '--player-surface': 'var(--surface-2)',
      '--player-border-top': 'none',
      '--player-radius': 'var(--radius-lg) var(--radius-lg) 0 0',
      '--player-inset': 'var(--space-4)',
      '--player-lift': '0px',
      '--player-height': 'calc(var(--player-bar-height) - var(--space-2))',
      '--player-shadow': 'var(--shadow-md), var(--ring-1) var(--border)',
      '--player-blur': 'none'
    }
  }
};

/** Порядок в настройках: от привычного к самому непохожему. */
export const PLAYER_SKIN_LIST: readonly PlayerSkin[] = PLAYER_SKIN_IDS.map((id) => PLAYER_SKINS[id]);

export function isPlayerSkinId(value: unknown): value is PlayerSkinId {
  return typeof value === 'string' && (PLAYER_SKIN_IDS as readonly string[]).includes(value);
}

/**
 * Переменные облика для инлайнового стиля полосы.
 *
 * Неизвестный ключ отдаёт облик по умолчанию, а не пустой набор: пустой означал
 * бы полосу без фона и без высоты, то есть исчезнувший плеер — на настройке, где
 * ошибиться проще всего, потому что значение приходит из базы.
 */
export function playerSkinVars(id: PlayerSkinId): CSSProperties {
  const skin = PLAYER_SKINS[id] ?? PLAYER_SKINS[DEFAULT_PLAYER_SKIN_ID];
  return skin.vars as CSSProperties;
}

/**
 * Ступень размеров транспорта для облика.
 *
 * Ответ на тот же испорченный ключ из базы, что и у `playerSkinVars`, и потому
 * такая же развилка: неизвестный облик получает размеры облика по умолчанию, а
 * не самые мелкие.
 */
export function playerSkinControls(id: PlayerSkinId): 'tight' | 'compact' {
  const skin = PLAYER_SKINS[id] ?? PLAYER_SKINS[DEFAULT_PLAYER_SKIN_ID];
  return skin.tightControls ? 'tight' : 'compact';
}
