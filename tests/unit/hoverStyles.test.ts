import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Предохранитель против самой дорогой ошибки в облике приложения: инлайновый
 * фон, который глушит `:hover` из таблицы стилей.
 *
 * Откуда он взялся. Объявление в атрибуте `style` старше любого правила
 * таблицы, кроме `!important`. Пока цвет покоя писался инлайном, ни один
 * `:hover` до элемента не доставал — и приложение доехало до проверки в
 * состоянии, где `.wireon-btn` (то есть каждая кнопка), строки боковой
 * панели, чипы Волны, закладки медиатеки и пилюля профиля объявляли переход
 * фона, а на наведение не отвечали вовсе. Глазами это не ловится: переход
 * объявлен, класс на месте, в CSS правило есть — просто оно не работает.
 *
 * Тест читает исходники, а не отрендеренное дерево, и это не лень: в
 * vitest.config.ts нет `css: true`, стили в прогоне не обрабатываются вообще,
 * и `getComputedStyle` про `:hover` ничего не знает. Так что проверяется
 * причина, а не следствие.
 */

const SRC = path.resolve(__dirname, '../../src');
const STYLES = path.join(SRC, 'styles');
const GLOBAL_CSS = path.join(STYLES, 'global.css');

/**
 * Все таблицы стилей приложения.
 *
 * Читается каталог, а не список из двух файлов: оформление разложено по темам
 * (частицы, обложки плеера, орб «Потока»), и новый файл не должен требовать
 * правки теста — иначе класс, объявленный в нём, посчитается несуществующим и
 * проверка «каждый класс объявлен» начнёт врать в обе стороны.
 */
function allCss(): string {
  return readdirSync(STYLES)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(path.join(STYLES, name), 'utf8'))
    .join('\n');
}

/**
 * Классы, чьё правило красит фон по наведению или по состоянию. Инлайновый фон
 * на таком элементе — всегда ошибка.
 */
const HOVER_PAINTED = [
  'press',
  'press-surface',
  'artwork-press',
  'chip',
  'segmented-tab',
  'menu-item-hover',
  'card-interactive',
  'sidebar-nav-item',
  'sidebar-playlist-item',
  'wireon-btn'
];

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsxFiles(full, acc);
    else if (entry.name.endsWith('.tsx')) acc.push(full);
  }
  return acc;
}

/**
 * Открывающий тег вокруг найденного `className`: назад до `<`, вперёд до `>`
 * верхнего уровня — вложенные `{...}` пропускаются, иначе выражение в атрибуте
 * оборвёт тег на своей первой `>`.
 */
function openingTag(source: string, classNameIndex: number, classNameEnd: number): string | null {
  const start = source.lastIndexOf('<', classNameIndex);
  if (start < 0) return null;
  let depth = 0;
  for (let i = classNameEnd; i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return source.slice(start, i);
  }
  return null;
}

interface Element {
  file: string;
  line: number;
  classes: Set<string>;
  tag: string;
}

function elementsWithClassName(): Element[] {
  const found: Element[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const rel = 'src/' + path.relative(SRC, file).replace(/\\/g, '/');
    for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const tag = openingTag(source, match.index, match.index + match[0].length);
      if (!tag) continue;
      // Выражения в шаблоне выкидываем: `${className}` — это не имя класса.
      const literal = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      found.push({
        file: rel,
        line: source.slice(0, match.index).split('\n').length,
        classes: new Set(literal.split(/\s+/).filter(Boolean)),
        // Комментарии из тега вырезаем: пояснение «`background: transparent`
        // убран» — не объявление, а рассказ о том, почему его тут нет.
        tag: tag.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      });
    }
  }
  return found;
}

describe('наведение и состояния в CSS, а не в инлайне', () => {
  const elements = elementsWithClassName();

  it('элементы с ховером из таблицы стилей не задают фон инлайново', () => {
    const offenders: string[] = [];

    for (const element of elements) {
      const painted = HOVER_PAINTED.filter((c) => element.classes.has(c));
      if (painted.length === 0) continue;
      // `background:` с двоеточием — чтобы не ловить backgroundImage и
      // backgroundSize: обложке фон-картинка нужна, и ховер она не глушит.
      if (!/backgroundColor\s*:|background\s*:/.test(element.tag)) continue;
      offenders.push(`${element.file}:${element.line} — .${painted.join('.')}`);
    }

    expect(
      offenders,
      'Инлайновый фон старше правила таблицы стилей, поэтому :hover до элемента ' +
        'не дойдёт. Перенесите цвет в правило класса, а состояние — в data-/aria-атрибут:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('каждый класс из разметки объявлен в таблице стилей или помечен как хук', () => {
    const css = allCss();
    const declared = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

    /*
     * Классы без правил, и это нормально: они существуют для поиска в тестах и
     * для смысла в разметке. Список закрытый нарочно — новый класс без правила
     * либо получает правило, либо попадает сюда осознанно. Именно так .press
     * и .hover-underline когда-то и оказались висящими на разметке впустую.
     */
    const SEMANTIC_HOOKS = new Set([
      'window-btn',
      'window-controls',
      'minimize-btn',
      'maximize-btn',
      'close-btn',
      'wireon-app-shell',
      'wireon-modal-backdrop',
      'wireon-search-bar-container',
      'wireon-search-view',
      'wave-view-container',
      'wave-controls-container',
      'wave-source-picker',
      'wave-tuner',
      'wave-visualizer-container'
    ]);

    const orphans = new Map<string, string>();
    for (const element of elements) {
      for (const cls of element.classes) {
        if (declared.has(cls) || SEMANTIC_HOOKS.has(cls) || orphans.has(cls)) continue;
        orphans.set(cls, `${element.file}:${element.line}`);
      }
    }

    expect(
      [...orphans].map(([cls, at]) => `.${cls} — ${at}`),
      'Класс висит на разметке, а правила для него нет. Либо добавьте правило в ' +
        'global.css, либо внесите в SEMANTIC_HOOKS, если это хук для тестов.'
    ).toEqual([]);
  });

  it('Button не задаёт цвета вариантов инлайново', () => {
    const source = readFileSync(path.join(SRC, 'components/common/Button.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Кнопка — примитив: если фон вернётся в её объект стилей, разом умрут
    // ховер и нажатое состояние у всех кнопок приложения.
    expect(/backgroundColor\s*:/.test(code), 'цвет варианта вернулся в инлайновый style').toBe(false);
    expect(code, 'вариант должен доходить до CSS через data-variant').toContain('data-variant=');
    expect(code, 'состояние isActive должно доходить до CSS через data-active').toContain('data-active=');
  });

  it('у каждого варианта кнопки есть и покой, и ответ на наведение', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');

    for (const variant of ['primary', 'secondary', 'danger', 'subtle', 'ghost', 'icon']) {
      const rest = new RegExp(`\\.wireon-btn\\[data-variant='${variant}'\\][^:]*\\{`);
      const hover = new RegExp(`\\.wireon-btn\\[data-variant='${variant}'\\][^{]*:hover`);
      expect(rest.test(css), `у варианта ${variant} нет правила покоя`).toBe(true);
      expect(hover.test(css), `у варианта ${variant} нет ответа на наведение`).toBe(true);
    }
  });

  it('inline transition не тянет all — под него попадает font-weight', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = 'src/' + path.relative(SRC, file).replace(/\\/g, '/');
      for (const match of source.matchAll(/transition:\s*['"`]all\b/g)) {
        offenders.push(`${rel}:${source.slice(0, match.index).split('\n').length}`);
      }
    }

    expect(
      offenders,
      '`transition: all` переходит и то, что переходить не должно: вместе с цветом ' +
        'браузер анимирует font-weight, и текст проходит через дробные веса. ' +
        'Перечислите свойства:\n' + offenders.join('\n')
    ).toEqual([]);
  });

  it('раскрывающийся список нарисован нами, а не системой', () => {
    // Пока `appearance` не сброшен, Chromium рисует орган управления сам:
    // системную стрелку и системную метрику подписи. Восемнадцать списков в
    // настройках оказывались единственными деталями приложения, до которых не
    // доставали ни пресет, ни выбранный шрифт, ни цвет акцента.
    const css = allCss();
    // Собираются все правила, чей последний селектор — `select`: их два, общее с
    // полями ввода и своё. Брать первое нельзя — родной вид сбрасывается во
    // втором, и проверка ловила бы не то правило.
    const rules = [...css.matchAll(/\nselect \{[^}]*\}/g)].map((match) => match[0]).join('\n');

    expect(rules, 'нет правила select — родной вид не сброшен').toBeTruthy();
    expect(rules).toMatch(/appearance:\s*none/);
    // Стрелка обязана быть из токена: SVG-картинка не умеет currentColor, и
    // зашитый цвет сделал бы её единственной деталью, не следующей за темой.
    expect(rules).toMatch(/background-image:[\s\S]*var\(--text-/);

    // Раскрытый список рисует Chromium цветами системной темы, если не сказать
    // иначе — на ночной теме открывалась белая простыня.
    expect(css).toMatch(/select option[\s\S]{0,60}\{[^}]*var\(--surface-/);
  });

  /**
   * Наведение на встроенную кнопку меню не должно двигать разметку.
   *
   * История: `.menu-item-hover:hover` сдвигает содержимое вправо, освобождая
   * место рельсу. Для строки меню это верно, для маленькой кнопки внутри
   * строки — нет: она от этого становится шире, подпись рядом теряет ширину и
   * переносится лишней строкой, панель подрастает, а меню боковой панели
   * раскрыто вверх и приколото нижним краем — вся стопка уезжает выше вместе с
   * кнопкой. Кнопка уходит из-под курсора, наведение спадает, всё возвращается
   * назад, и так по кругу. Владелец описал это как «чуть криво наведёшься на
   * „Проверить“ — мерцает туда-сюда».
   *
   * Ловится это только порядком и весом селекторов, поэтому тест смотрит
   * ровно на них: голый `.menu-item-inline` слабее `.menu-item-hover:hover` и
   * лежал выше — то есть не отменял ни сдвиг, ни рельс, хотя выглядел так,
   * будто отменяет.
   */
  it('встроенная кнопка меню не меняет разметку по наведению', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');

    const hoverAt = css.indexOf('.menu-item-hover:hover');
    const inlineAt = css.indexOf('.menu-item-hover.menu-item-inline');
    expect(hoverAt, 'нет правила наведения строки меню').toBeGreaterThan(-1);
    expect(inlineAt, 'встроенная кнопка объявлена не составным селектором').toBeGreaterThan(-1);
    expect(inlineAt, 'встроенная кнопка объявлена выше наведения — оно её перебьёт').toBeGreaterThan(
      hoverAt
    );

    // Отступ возвращается на своё место именно в состоянии наведения.
    expect(css).toMatch(
      /\.menu-item-hover\.menu-item-inline:hover,[\s\S]{0,80}?:focus-visible \{[^}]*padding-left:\s*var\(--space-2\)/
    );

    // Рельс — признак строки меню; на кнопке внутри строки его быть не должно.
    expect(css).toMatch(/\.menu-item-hover\.menu-item-inline::before \{[^}]*content:\s*none/);

    // Отступ не должен и плавно ехать: переход по padding-left оставлял бы ту
    // же качку, просто растянутую во времени.
    const inlineBase = css.slice(inlineAt, css.indexOf('}', inlineAt));
    expect(inlineBase).not.toMatch(/padding-left/);
    expect(inlineBase).toMatch(/transition:[^;]*/);
    expect(inlineBase.match(/transition:[^;]*/)?.[0]).not.toContain('padding-left');
  });

  /**
   * Пар темы «Дымка» — слой поверх всего окна.
   *
   * Владелец просил не полупрозрачные панели, а эффект на весь экран: «будто
   * пошёл дождь, а на улице жарко и пар идёт». Панели дают стекло, но не
   * воздух — между глазом и картинкой должно что-то висеть, поэтому слой лежит
   * НАД содержимым.
   *
   * Отсюда два требования, которые легко потерять при правке: он не должен
   * ловить нажатия (иначе накроет собой всё приложение) и не должен быть виден
   * в остальных темах.
   */
  it('слой пара не ловит нажатия и включается только «Дымкой»', () => {
    const css = readFileSync(GLOBAL_CSS, 'utf8');

    const base = css.slice(css.indexOf('.haze-steam {'), css.indexOf('}', css.indexOf('.haze-steam {')));
    expect(base, 'нет правила .haze-steam').toBeTruthy();
    // Слой лежит над интерфейсом: без этого он накрыл бы собой всё приложение.
    expect(base).toMatch(/pointer-events:\s*none/);
    // В покое его нет вовсе — иначе он висел бы над каждой темой.
    expect(base).toMatch(/opacity:\s*0/);

    expect(css).toMatch(/\[data-preset='haze'\] \.haze-steam \{[^}]*opacity:\s*1/);

    // Своего правила под «сокращённое движение» у слоя быть не должно: общее
    // правило и так останавливает всякую анимацию, а второй такой блок выше по
    // файлу ломает проверки, которые ищут общий блок по первому вхождению.
    const steamAt = css.indexOf('.haze-steam');
    const firstReduced = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(firstReduced, 'общий блок сокращённого движения пропал').toBeGreaterThan(steamAt);
  });

  it('длительности и кривые переходов берутся из токенов', () => {
    const offenders: string[] = [];

    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      const rel = 'src/' + path.relative(SRC, file).replace(/\\/g, '/');
      // Литеральная длительность внутри transition. Токены схлопываются при
      // prefers-reduced-motion, а зашитые 400ms — нет: их правило
      // transition-duration: 1ms !important тоже накрывает, но длительность в
      // токене ещё и согласована с остальными состояниями.
      for (const match of source.matchAll(/transition:\s*(['"`])((?:(?!\1)[\s\S])*)\1/g)) {
        if (!/\d+\s*m?s/.test(match[2])) continue;
        offenders.push(`${rel}:${source.slice(0, match.index).split('\n').length} — ${match[2]}`);
      }
    }

    expect(
      offenders,
      'Длительность перехода задана числом. Возьмите --dur-fast / --dur-normal / ' +
        '--dur-slow, иначе состояния разъезжаются по темпу:\n' + offenders.join('\n')
    ).toEqual([]);
  });
});
