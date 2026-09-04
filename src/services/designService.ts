import { applyAccent } from './themeService';
import {
  designVarNames,
  designVars,
  resolveDepth,
  type DesignSelection,
  type ParticleProfileId
} from '../styles/presets';
import { typographyVars, DEFAULT_TYPOGRAPHY, type TypographySelection } from '../styles/typography';
import { isThemeDepth, DEFAULT_THEME_DEPTH } from '../styles/palette';

/**
 * Единственное место, которое пишет оформление в документ.
 *
 * Пресет, глубина, гарнитура и акцент — четыре независимых выбора, но применяться
 * они обязаны одним заходом: пресет диктует лестницу поверхностей, глубина —
 * светлоту, а акцент в светлой теме приводится к читаемому. Разложить это на
 * четыре независимых применения нельзя — получались бы кадры с несогласованным
 * набором переменных (тёмные панели и чёрный текст).
 *
 * Почему инлайновый `style` на `<html>`, а не тег `<style>`: он перебивает `:root`
 * из таблицы стилей без борьбы за специфичность, переменные видны всему дереву, а
 * снятие свойства возвращает значение из CSS — то есть откат бесплатен.
 *
 * Атрибуты `data-*` при этом всё равно нужны: по ним таблица стилей включает
 * правила, которые переменными не выражаются, — рамки стеклянных слоёв, поведение
 * частиц, полярность светлой темы.
 *
 * Состояния здесь нет: модуль применяет то, что передали. Помнит выбор
 * `useDesignStore`, и это разделение позволяет проверять математику оформления без
 * документа, а хранилище — без окна.
 */

/** Документа может не быть: smoke-режим и тесты — штатные случаи, не ошибка. */
function root(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Сколько держится метка `data-preset-shift`.
 *
 * Чуть больше `--dur-preset-shift` из таблицы стилей: метка обязана пережить
 * последний кадр перехода, а лишние восемьдесят миллисекунд ничего не значат —
 * пока она висит, меняется только то, как элементы догоняют новые значения.
 */
const SHIFT_HOLD_MS = 420;

let shiftTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Помечает документ на время смены оформления.
 *
 * Зачем метка: значения пользовательских свойств браузер не интерполирует, и
 * смена пресета без неё — склейка двух кадров. Правило под `data-preset-shift`
 * (global.css) на это время объявляет переход у того, что из этих переменных
 * считается, — цвета, тени, скругления.
 *
 * Ставится на каждое применение, кроме первого. Сравнивать значения со
 * предыдущими незачем: `applyDesign` вызывается только когда человек что-то
 * выбрал, а хранить прошлый выбор здесь — значит завести состояние в модуле,
 * которое оно намеренно не держит.
 */
function beginShift(el: HTMLElement): void {
  el.dataset.presetShift = '';

  // Переход не сыграет, если правило и новые значения попадут в один пересчёт
  // стиля: браузеру нужен кадр, где переход объявлен, а значения ещё старые.
  // Чтение вычисленного стиля этот пересчёт и вызывает.
  if (typeof getComputedStyle === 'function') {
    getComputedStyle(el).getPropertyValue('--dur-preset-shift');
  }

  if (shiftTimer !== null) clearTimeout(shiftTimer);
  shiftTimer = setTimeout(() => {
    shiftTimer = null;
    delete el.dataset.presetShift;
  }, SHIFT_HOLD_MS);
}

export interface DesignApplication extends DesignSelection {
  typography: TypographySelection;
}

/** Порог тот же, что у боковой панели и полосы плеера — DESIGN_SYSTEM §15. */
const NARROW_QUERY = '(max-width: 768px)';

/**
 * Узкий ли сейчас экран.
 *
 * Читается из JS, а не задаётся правилом `@media`, вынужденно: кегли пишет
 * инлайном сам `applyDesign`, а инлайновое свойство сильнее любого правила из
 * таблицы. Переопределить `--text-*` брейкпоинтом нельзя в принципе — как и
 * `--player-bar-height`, по той же причине.
 */
function isNarrowViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/**
 * Последнее применённое оформление — чтобы пересобрать кегли, когда окно
 * перешло порог. Без этого набор менялся бы только после перезапуска: на
 * телефоне это незаметно, а в окне, которое тянут мышью, — сразу.
 */
let lastApplied: DesignApplication | null = null;
let narrowWatcher: MediaQueryList | null = null;

function watchViewport(): void {
  if (narrowWatcher || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  narrowWatcher = window.matchMedia(NARROW_QUERY);
  narrowWatcher.addEventListener('change', () => {
    if (lastApplied) applyDesign(lastApplied);
  });
}

/**
 * Применяет оформление целиком.
 *
 * Порядок важен: сначала атрибут глубины, потом переменные, и только затем
 * акцент — он читает глубину из документа, чтобы привести пастель к читаемой на
 * белом.
 */
export function applyDesign(selection: DesignApplication): void {
  const el = root();
  if (!el) return;

  const depth = resolveDepth(selection.presetId, selection.depth);

  // Первое применение — не смена оформления, а загрузка: переход показал бы, как
  // приложение проявляется из значений таблицы стилей.
  if (el.dataset.preset !== undefined) beginShift(el);

  el.dataset.theme = depth;
  el.dataset.preset = selection.presetId;

  const vars = {
    ...designVars({ ...selection, depth }),
    ...typographyVars(selection.typography, isNarrowViewport())
  };
  for (const [name, value] of Object.entries(vars)) {
    el.style.setProperty(name, value);
  }

  applyAccent(selection.accentHex, depth);

  lastApplied = selection;
  watchViewport();
}

/**
 * Профиль частиц уходит в атрибут, а не в переменную.
 *
 * Слой частиц — это canvas, и ему нужен не цвет, а решение «рисовать или нет».
 * Атрибут читается и из CSS (можно погасить слой правилом), и из JS без разбора
 * инлайновых стилей.
 */
export function applyParticles(profile: ParticleProfileId): void {
  const el = root();
  if (!el) return;
  el.dataset.particles = profile;
}

/**
 * Снимает всё, что писал `applyDesign`.
 *
 * Нужно не для отката пресета — тот просто перезаписывает те же имена, — а для
 * тестов и для аварийного возврата к оформлению из таблицы стилей, если выбор в
 * базе оказался испорченным.
 */
export function clearDesign(): void {
  const el = root();
  if (!el) return;

  for (const name of designVarNames()) el.style.removeProperty(name);
  for (const name of Object.keys(typographyVars(DEFAULT_TYPOGRAPHY))) el.style.removeProperty(name);

  // Метка снимается вместе с оформлением, иначе отложенное снятие сработало бы
  // уже поверх следующего применения.
  if (shiftTimer !== null) {
    clearTimeout(shiftTimer);
    shiftTimer = null;
  }
  delete el.dataset.presetShift;

  delete el.dataset.preset;
  delete el.dataset.particles;
}

/**
 * Текущая длительность ухода в миллисекундах.
 *
 * Читается из документа, а не считается из выбора: анимация ухода живёт в CSS, и
 * единственный надёжный источник — то значение, которое браузер реально применил.
 * Так учитывается и системная настройка «меньше движения», схлопывающая
 * длительности до миллисекунды, — при расчёте из пресета мы бы держали элемент в
 * дереве полную длительность у того, кто анимаций не просил.
 *
 * `fallback` возвращается, когда документа нет или значение не разобралось: без
 * него уходящий элемент остался бы в дереве навсегда.
 */
export function readExitMs(fallback: number): number {
  const el = root();
  if (!el || typeof getComputedStyle !== 'function') return fallback;

  const raw = getComputedStyle(el).getPropertyValue('--dur-fast').trim();
  if (!raw) return fallback;

  const ms = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : NaN;
  if (!Number.isFinite(ms) || ms < 0) return fallback;

  // Ноль — законное значение при «меньше движения», но снимать элемент в том же
  // кадре нельзя: React не успеет отрисовать конечное состояние.
  return Math.max(1, Math.round(ms));
}

/** Глубина, в которой документ находится прямо сейчас. */
export function currentDepth() {
  const el = root();
  const value = el?.dataset.theme;
  return isThemeDepth(value) ? value : DEFAULT_THEME_DEPTH;
}
