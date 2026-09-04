import { create } from 'zustand';
import * as dbService from '../services/db';
import { DEFAULT_PLAYER_SKIN_ID, PLAYER_SKIN_IDS, PlayerSkinId } from '../styles/playerSkins';
import { DEFAULT_MINI_SKIN_ID, MINI_SKIN_IDS, MiniSkinId } from '../styles/miniSkins';

/**
 * Разметка плеера: что показывать в полосе и в полноэкранном режиме, насколько
 * плотно и какой формы обложка.
 *
 * Живёт отдельно от `usePlayerStore` намеренно. Тот стор — про звук и очередь,
 * и подписка на него уже идёт из десятка мест; добавлять туда предпочтения
 * внешнего вида значило бы будить транспорт при каждом переключателе в
 * настройках. Здесь же ни одно значение не меняется во время воспроизведения,
 * так что подписчики перерисовываются только по действию человека.
 *
 * Все значения по умолчанию равны тому, как плеер выглядит сегодня: настройки
 * ничего не включают и не выключают до первого касания.
 */

export type PlayerDensity = 'compact' | 'comfortable' | 'spacious';
export type ArtworkShape = 'square' | 'rounded' | 'circle';
export type ArtworkClickAction = 'fullscreen' | 'visualizer' | 'none';
export type ProgressStyle = 'thin' | 'thick';

export const PLAYER_DENSITIES: readonly PlayerDensity[] = ['compact', 'comfortable', 'spacious'];
export const ARTWORK_SHAPES: readonly ArtworkShape[] = ['square', 'rounded', 'circle'];
export const ARTWORK_CLICK_ACTIONS: readonly ArtworkClickAction[] = ['fullscreen', 'visualizer', 'none'];
export const PROGRESS_STYLES: readonly ProgressStyle[] = ['thin', 'thick'];

/**
 * Модули полосы плеера. Список закрытый и описывает только то, что в полосе
 * действительно есть — ничего «на будущее»: переключатель без элемента на
 * экране выглядит как поломка.
 */
export const PLAYER_BAR_MODULE_KEYS = [
  'favorite',
  'shuffle',
  'repeat',
  'queue',
  'lyrics',
  'tempo',
  'sleepTimer',
  'volume',
  'visualizer'
] as const;

export type PlayerBarModuleKey = (typeof PLAYER_BAR_MODULE_KEYS)[number];

/** Блоки полноэкранного плеера. */
export const FULLSCREEN_MODULE_KEYS = ['artwork', 'visualizer', 'lyrics', 'queue'] as const;

export type FullscreenModuleKey = (typeof FULLSCREEN_MODULE_KEYS)[number];

/**
 * Свои ключи в таблице настроек, с префиксом: `usePlayerStore` уже занял
 * короткие имена вида `volume` и `visualizerEnabled`, и совпадение затирало бы
 * настоящую громкость.
 */
export const PLAYER_LAYOUT_SETTING_KEYS = {
  density: 'playerLayoutDensity',
  artworkShape: 'playerLayoutArtworkShape',
  artworkClickAction: 'playerLayoutArtworkClick',
  progressStyle: 'playerLayoutProgressStyle',
  skinId: 'playerLayoutSkin',
  miniSkinId: 'playerLayoutMiniSkin',
  modules: 'playerLayoutModules',
  fullscreenModules: 'playerLayoutFullscreenModules'
} as const;

export interface DensityMetrics {
  /** Зазор между тремя зонами полосы. */
  barGap: string;
  /** Внутренние отступы полосы, `padding` целиком. */
  barPadding: string;
  /** Сторона обложки в полосе. */
  artworkSize: string;
  /** Зазор внутри блока «что играет». */
  metaGap: string;
  /** Зазор между кнопками справа внутри одной группы. */
  controlsGap: string;
  /**
   * Зазор между группами кнопок справа.
   *
   * Правый край полосы — это восемь-девять органов управления подряд, и без
   * группировки они читались одной стеной одинаковых значков: глаз не находил, где
   * кончается громкость и начинается «во весь экран». Группы разделены не линией, а
   * расстоянием: лишняя черта — это ещё один нарисованный предмет, а пауза шире
   * обычного зазора делает ту же работу молча. Ступень ровно одна, поэтому пауза
   * заметна, но группы остаются одним блоком у правого края.
   */
  controlsGroupGap: string;
}

/**
 * Три ступени плотности. `comfortable` — ровно текущие числа полосы, поэтому
 * значение по умолчанию ничего не сдвигает. Обложка нигде не выходит за
 * `--player-bar-height` (88px) вместе с отступами.
 */
export const DENSITY_METRICS: Record<PlayerDensity, DensityMetrics> = {
  compact: {
    barGap: 'var(--space-3)',
    barPadding: '0 var(--space-4)',
    artworkSize: '44px',
    metaGap: 'var(--space-2)',
    controlsGap: 'var(--space-1)',
    controlsGroupGap: 'var(--space-3)'
  },
  comfortable: {
    barGap: 'var(--space-4)',
    barPadding: '0 var(--space-5)',
    artworkSize: '52px',
    metaGap: 'var(--space-3)',
    controlsGap: 'var(--space-2)',
    controlsGroupGap: 'var(--space-4)'
  },
  spacious: {
    barGap: 'var(--space-5)',
    barPadding: '0 var(--space-6)',
    artworkSize: '60px',
    metaGap: 'var(--space-4)',
    controlsGap: 'var(--space-3)',
    controlsGroupGap: 'var(--space-5)'
  }
};

/** Радиус обложки в полосе. `rounded` — то, что стоит там сейчас. */
export const ARTWORK_RADIUS: Record<ArtworkShape, string> = {
  square: '0',
  rounded: 'var(--radius-sm)',
  circle: 'var(--radius-full)'
};

/**
 * Радиус большой обложки. Тот же выбор формы, но другой масштаб: `--radius-sm`
 * на картинке 360px не читается как скругление вовсе.
 */
export const FULLSCREEN_ARTWORK_RADIUS: Record<ArtworkShape, string> = {
  square: '0',
  rounded: 'var(--radius-lg)',
  circle: 'var(--radius-full)'
};

/**
 * Толщина полосок прокрутки и громкости — через переопределение токенов темы на
 * контейнере плеера. Новых классов не появляется: `global.css` §7 разрешает
 * `--range-track-height` и `--range-thumb-size` на самих дорожках, а
 * пользовательские свойства наследуются.
 *
 * У `thin` пустой набор осознанно: это и есть значения из `theme.css`
 * (6px/12px), и повторять их здесь значило бы держать вторую копию числа,
 * которая молча разойдётся с темой.
 */
export const PROGRESS_STYLE_VARS: Record<ProgressStyle, Record<string, string>> = {
  thin: {},
  thick: {
    '--range-track-height': '10px',
    '--range-thumb-size': '16px'
  }
};

export interface PlayerLayoutState {
  density: PlayerDensity;
  artworkShape: ArtworkShape;
  artworkClickAction: ArtworkClickAction;
  progressStyle: ProgressStyle;
  /**
   * Облик полосы: чем плеер является — полосой, таблеткой, стеклом, линией.
   *
   * Отдельно от плотности и формы обложки, потому что отвечает на другой вопрос.
   * Плотность отмеряет, сколько места занимают те же самые элементы; облик меняет
   * саму вещь, и оба выбора осмысленны в любой комбинации.
   */
  skinId: PlayerSkinId;
  /**
   * Облик мини-плеера — отдельного окна поверх остальных.
   *
   * Своё поле, а не то же самое, что у полосы: окно 340×132 и полоса во всю
   * ширину — разные предметы, и «Пульт» с крупными цифрами, осмысленный в полосе,
   * в окне размером с уведомление не поместился бы вовсе. Лежит здесь, а не в
   * `useUIStore`, чтобы получить сохранение и чтение из базы — а заодно потому,
   * что мини-окно гидратирует именно этот стор (`src/main.tsx`).
   */
  miniSkinId: MiniSkinId;
  modules: Record<PlayerBarModuleKey, boolean>;
  fullscreenModules: Record<FullscreenModuleKey, boolean>;
  /** Уже читали базу? Компоненты на это не подписываются, флаг для стора. */
  layoutHydrated: boolean;
}

export interface PlayerLayoutStore extends PlayerLayoutState {
  setDensity: (density: PlayerDensity) => void;
  setArtworkShape: (shape: ArtworkShape) => void;
  setArtworkClickAction: (action: ArtworkClickAction) => void;
  setProgressStyle: (style: ProgressStyle) => void;
  setPlayerSkin: (id: PlayerSkinId) => void;
  setMiniSkin: (id: MiniSkinId) => void;
  toggleModule: (key: PlayerBarModuleKey) => void;
  toggleFullscreenModule: (key: FullscreenModuleKey) => void;
  resetLayout: () => void;
  hydratePlayerLayout: () => Promise<void>;
}

function allEnabled<K extends string>(keys: readonly K[]): Record<K, boolean> {
  return keys.reduce(
    (acc, key) => {
      acc[key] = true;
      return acc;
    },
    {} as Record<K, boolean>
  );
}

/**
 * Свежая копия значений по умолчанию на каждый вызов: `resetLayout` иначе
 * вернул бы ту же самую ссылку на `modules`, которую до этого мутировали бы
 * переключатели, и «сбросить» перестало бы что-либо сбрасывать.
 */
function createDefaults(): PlayerLayoutState {
  return {
    density: 'comfortable',
    artworkShape: 'rounded',
    artworkClickAction: 'fullscreen',
    progressStyle: 'thin',
    skinId: DEFAULT_PLAYER_SKIN_ID,
    miniSkinId: DEFAULT_MINI_SKIN_ID,
    modules: allEnabled(PLAYER_BAR_MODULE_KEYS),
    fullscreenModules: allEnabled(FULLSCREEN_MODULE_KEYS),
    layoutHydrated: false
  };
}

/** Значение из базы принимается только если оно есть в списке допустимых. */
function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Карта переключателей из базы. Проверяется каждый ключ по отдельности: один
 * испорченный флаг не должен отменять остальные, а лишние ключи (например, от
 * будущей версии) просто игнорируются.
 */
function normalizeModules<K extends string>(
  raw: unknown,
  keys: readonly K[],
  fallback: Record<K, boolean>
): Record<K, boolean> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback };
  const source = raw as Record<string, unknown>;
  return keys.reduce(
    (acc, key) => {
      const value = source[key];
      acc[key] = typeof value === 'boolean' ? value : fallback[key];
      return acc;
    },
    {} as Record<K, boolean>
  );
}

/** Поверхностное сравнение двух карт переключателей по известным ключам. */
function sameModules<K extends string>(
  a: Record<K, boolean>,
  b: Record<K, boolean>,
  keys: readonly K[]
): boolean {
  return keys.every((key) => a[key] === b[key]);
}

/** Ошибка записи предпочтения не должна доходить до интерфейса. */
function persistSetting(key: string, value: unknown): void {
  try {
    const result = dbService.setSetting(key, value);
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        console.warn(`[usePlayerLayoutStore] Could not persist "${key}":`, err);
      });
    }
  } catch (err) {
    console.warn(`[usePlayerLayoutStore] Could not persist "${key}":`, err);
  }
}

/**
 * Держится вне стора: два компонента могут вызвать гидратацию в один кадр, и
 * без общего обещания оба ушли бы читать базу.
 */
let hydrationPromise: Promise<void> | null = null;

export const usePlayerLayoutStore = create<PlayerLayoutStore>()((set, get) => ({
  ...createDefaults(),

  setDensity: (density) => {
    set({ density });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.density, density);
  },

  setArtworkShape: (shape) => {
    set({ artworkShape: shape });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, shape);
  },

  setArtworkClickAction: (action) => {
    set({ artworkClickAction: action });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction, action);
  },

  setProgressStyle: (style) => {
    set({ progressStyle: style });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, style);
  },

  setPlayerSkin: (id) => {
    set({ skinId: id });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, id);
  },

  setMiniSkin: (id) => {
    set({ miniSkinId: id });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.miniSkinId, id);
  },

  toggleModule: (key) => {
    const next = { ...get().modules, [key]: !get().modules[key] };
    set({ modules: next });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.modules, next);
  },

  toggleFullscreenModule: (key) => {
    const next = { ...get().fullscreenModules, [key]: !get().fullscreenModules[key] };
    set({ fullscreenModules: next });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules, next);
  },

  resetLayout: () => {
    const defaults = createDefaults();
    // `layoutHydrated` не сбрасывается: база уже прочитана, и повторное чтение
    // тут же вернуло бы то, что человек только что просил убрать.
    set({ ...defaults, layoutHydrated: get().layoutHydrated });
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.density, defaults.density);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, defaults.artworkShape);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction, defaults.artworkClickAction);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, defaults.progressStyle);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.skinId, defaults.skinId);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.miniSkinId, defaults.miniSkinId);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.modules, defaults.modules);
    persistSetting(PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules, defaults.fullscreenModules);
  },

  hydratePlayerLayout: async () => {
    if (get().layoutHydrated) return;
    if (hydrationPromise) return hydrationPromise;

    hydrationPromise = (async () => {
      const current = get();
      try {
        const [density, artworkShape, artworkClickAction, progressStyle, skinId, miniSkinId, modules, fullscreenModules] =
          await Promise.all([
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.density, current.density),
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.artworkShape, current.artworkShape),
            dbService.getSetting<unknown>(
              PLAYER_LAYOUT_SETTING_KEYS.artworkClickAction,
              current.artworkClickAction
            ),
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.progressStyle, current.progressStyle),
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.skinId, current.skinId),
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.miniSkinId, current.miniSkinId),
            dbService.getSetting<unknown>(PLAYER_LAYOUT_SETTING_KEYS.modules, current.modules),
            dbService.getSetting<unknown>(
              PLAYER_LAYOUT_SETTING_KEYS.fullscreenModules,
              current.fullscreenModules
            )
          ]);

        const patch: Partial<PlayerLayoutState> = {};
        const nextDensity = pickEnum(density, PLAYER_DENSITIES, current.density);
        const nextShape = pickEnum(artworkShape, ARTWORK_SHAPES, current.artworkShape);
        const nextClick = pickEnum(artworkClickAction, ARTWORK_CLICK_ACTIONS, current.artworkClickAction);
        const nextProgress = pickEnum(progressStyle, PROGRESS_STYLES, current.progressStyle);
        const nextSkin = pickEnum(skinId, PLAYER_SKIN_IDS, current.skinId);
        const nextMiniSkin = pickEnum(miniSkinId, MINI_SKIN_IDS, current.miniSkinId);
        const nextModules = normalizeModules(modules, PLAYER_BAR_MODULE_KEYS, current.modules);
        const nextFullscreen = normalizeModules(
          fullscreenModules,
          FULLSCREEN_MODULE_KEYS,
          current.fullscreenModules
        );

        if (nextDensity !== current.density) patch.density = nextDensity;
        if (nextShape !== current.artworkShape) patch.artworkShape = nextShape;
        if (nextClick !== current.artworkClickAction) patch.artworkClickAction = nextClick;
        if (nextProgress !== current.progressStyle) patch.progressStyle = nextProgress;
        if (nextSkin !== current.skinId) patch.skinId = nextSkin;
        if (nextMiniSkin !== current.miniSkinId) patch.miniSkinId = nextMiniSkin;
        // Карты сравниваются по значениям: `normalizeModules` всегда возвращает
        // новый объект, и запись «как было» иначе меняла бы ссылку — а плеер
        // подписан именно на неё и перерисовался бы на пустом месте.
        if (!sameModules(nextModules, current.modules, PLAYER_BAR_MODULE_KEYS)) patch.modules = nextModules;
        if (!sameModules(nextFullscreen, current.fullscreenModules, FULLSCREEN_MODULE_KEYS)) {
          patch.fullscreenModules = nextFullscreen;
        }

        if (Object.keys(patch).length > 0) set(patch);
      } catch (err) {
        console.warn('[usePlayerLayoutStore] Could not hydrate persisted layout:', err);
      } finally {
        // Флаг ставится и после ошибки: недоступная база — это причина остаться
        // на значениях по умолчанию, а не перечитывать её на каждом рендере.
        set({ layoutHydrated: true });
        hydrationPromise = null;
      }
    })();

    return hydrationPromise;
  }
}));
