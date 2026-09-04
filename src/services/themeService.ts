import {
  ACCENT_CSS_VARS,
  accentForDepth,
  DEFAULT_ACCENT_HEX,
  DEFAULT_THEME_DEPTH,
  deriveAccentShades,
  isThemeDepth,
  normalizeHex,
  type AccentShades,
  type ThemeDepth
} from '../styles/palette';

/**
 * Единственное место, которое пишет тему в документ.
 *
 * Зачем вообще писать цвет из JS: глубина темы — это набор готовых значений, её
 * умеет переключить сам CSS по атрибуту `data-theme`. А вот акцент человек
 * выбирает пипеткой, и вывести из произвольного цвета оттенки наведения,
 * нажатия и подложки CSS не может — этим занимается `deriveAccentShades`, а
 * результат кладётся в инлайновый `style` элемента `<html>`, потому что он
 * перебивает `:root` из таблицы стилей и не требует ни отдельного тега `<style>`,
 * ни перезаписи правил.
 *
 * Здесь нет ни состояния, ни хранилища: модуль только применяет то, что ему
 * передали. Помнит выбор `useThemeStore`, и такое разделение позволяет
 * проверять цветовую математику без хранилища, а хранилище — без документа.
 *
 * Хранилища здесь не импортируются намеренно: тогда любой вызов применения темы
 * тянул бы за собой zustand и слой базы.
 */

/**
 * Корень документа, если он есть.
 *
 * Приложение живёт не только в окне: код исполняется и в smoke-режиме, и в
 * тестах, где документа может не быть вовсе. Падение на первом же кадре из-за
 * оформления недопустимо, поэтому отсутствие документа — не ошибка, а штатный
 * случай: применять некуда, выбор всё равно останется в базе.
 */
function themeRoot(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/**
 * Глубина, в которой документ находится прямо сейчас.
 *
 * Читается из самого документа, а не передаётся отовсюду: смена акцента не обязана
 * знать про тему, а пересчитать оттенки без глубины нельзя — в светлой теме тот
 * же цвет приводится к читаемому (см. `accentForDepth`). Атрибут ставит только
 * `applyDepth`, поэтому источник один.
 */
function currentDepth(root: HTMLElement): ThemeDepth {
  const value = root.dataset.theme;
  return isThemeDepth(value) ? value : DEFAULT_THEME_DEPTH;
}

/**
 * Раскладывает акцент по CSS-переменным.
 *
 * Имена берутся из `ACCENT_CSS_VARS`, а не пишутся строками: список переменных
 * — договор с таблицей стилей, и держать его в двух местах значит однажды
 * забыть одну. `--text-on-accent` считать отдельно не нужно, `deriveAccentShades`
 * уже выбрал его через `pickTextOnAccent`.
 *
 * Мусор на входе не роняет оформление: непонятный цвет заменяется акцентом по
 * умолчанию, иначе одно битое значение в базе оставило бы интерфейс без акцента.
 */
export function applyAccent(accentHex: string, depth?: ThemeDepth): void {
  const root = themeRoot();
  if (!root) return;

  const chosen = normalizeHex(accentHex) ?? DEFAULT_ACCENT_HEX;
  const shades: AccentShades = deriveAccentShades(
    accentForDepth(chosen, depth ?? currentDepth(root))
  );
  const names = Object.keys(ACCENT_CSS_VARS) as (keyof AccentShades)[];

  for (const name of names) {
    root.style.setProperty(ACCENT_CSS_VARS[name], shades[name]);
  }
}

/**
 * Переключает глубину темы.
 *
 * Значение уходит в `data-theme` на `<html>` — дальше всё делает theme.css.
 * «Сумерки» своего блока не имеют, они и есть `:root`, поэтому атрибут для них
 * ставится тоже: важно, чтобы он всегда отражал выбор, а не иногда отсутствовал.
 */
export function applyDepth(depth: ThemeDepth): void {
  const root = themeRoot();
  if (!root) return;

  root.dataset.theme = isThemeDepth(depth) ? depth : DEFAULT_THEME_DEPTH;
}

export interface ThemeSelection {
  accentHex: string;
  depth: ThemeDepth;
}

/**
 * Применяет весь выбор целиком — этим пользуется и восстановление из базы, и
 * смена глубины: порядок важен, сначала атрибут, потом цвет, потому что в
 * светлой теме акцент приводится к читаемому под её белые подложки.
 */
export function applyTheme({ accentHex, depth }: ThemeSelection): void {
  applyDepth(depth);
  applyAccent(accentHex, depth);
}
