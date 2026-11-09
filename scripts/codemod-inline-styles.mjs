#!/usr/bin/env node
/**
 * Переводит инлайн-стили `style={{ … }}` в утилитарные классы из global.css.
 *
 * Берёт только то, что переводится один в один (раскладка, отступы из шкалы,
 * цвет и кегль из токенов). Всё, что не узнал, оставляет инлайном — значения из
 * данных и редкие свойства так и должны жить в `style`. Запуск:
 *
 *   node scripts/codemod-inline-styles.mjs [--write] [путь…]
 *
 * Без `--write` только считает. Класс дописывается в существующий `className`,
 * если это строка, шаблонная строка или вызов clsx/cn; иной выражение не
 * трогается — такие места правятся руками.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const write = process.argv.includes('--write');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const roots = targets.length ? targets : ['src/components', 'src/App.tsx'];

function files(p, acc = []) {
  const st = statSync(p);
  if (st.isDirectory()) for (const e of readdirSync(p)) files(path.join(p, e), acc);
  else if (/\.tsx$/.test(p)) acc.push(p);
  return acc;
}

/** Пиксели, которые точно равны шагу шкалы. */
const PX = { "'4px'": 1, '4': 1, "'8px'": 2, '8': 2, "'12px'": 3, '12': 3, "'16px'": 4, '16': 4, "'24px'": 5, '24': 5, "'32px'": 6, '32': 6 };
const SPACE = /^'?var\(--space-([1-8])\)'?$/;
const SIZES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'];
const TOKEN = (prefix) => new RegExp(`^'var\\(--${prefix}-([a-z0-9]+)\\)'$`);

/** Одна пара → класс или null (не переводится). Контекст — весь объект. */
function classFor(key, value, all) {
  const v = value.trim();
  const is = (...xs) => xs.includes(v);
  switch (key) {
    case 'display':
      if (is("'flex'")) {
        const dir = all.flexDirection, ai = all.alignItems;
        if (dir === "'column'") {
          if (!ai) return 'stack';
          if (ai === "'center'") return 'stack-center';
          if (ai === "'stretch'") return 'stack-stretch';
          if (ai === "'flex-start'") return 'stack items-start';
          if (ai === "'flex-end'") return 'stack items-end';
          return null;
        }
        if (dir && dir !== "'row'") return null;
        if (!ai) return 'row-stretch';
        if (ai === "'center'") return 'row';
        if (ai === "'flex-start'") return 'row-start';
        if (ai === "'flex-end'") return 'row-end';
        if (ai === "'baseline'") return 'row-stretch items-baseline';
        if (ai === "'stretch'") return 'row-stretch items-stretch';
        return null;
      }
      if (is("'inline-flex'")) return all.alignItems === "'center'" || !all.alignItems ? (all.flexDirection ? null : 'inline-row') : null;
      if (is("'grid'")) return 'grid';
      if (is("'block'")) return 'block';
      return null;
    case 'flexDirection': return all.display === "'flex'" ? '' : null; // учтено в display
    case 'alignItems': {
      if (all.display === "'flex'" || all.display === "'inline-flex'") return ''; // учтено в display
      const m = { "'center'": 'items-center', "'flex-start'": 'items-start', "'flex-end'": 'items-end', "'baseline'": 'items-baseline', "'stretch'": 'items-stretch' };
      return m[v] ?? null;
    }
    case 'alignSelf': return { "'center'": 'self-center', "'flex-start'": 'self-start', "'flex-end'": 'self-end', "'stretch'": 'self-stretch' }[v] ?? null;
    case 'justifyContent': return { "'space-between'": 'justify-between', "'center'": 'justify-center', "'flex-end'": 'justify-end', "'flex-start'": 'justify-start' }[v] ?? null;
    case 'flexWrap': return v === "'wrap'" ? 'wrap' : null;
    case 'gap': {
      if (is('0', "'0'")) return 'gap-0';
      if (is("'2px'", '2')) return 'gap-px';
      if (PX[v]) return `gap-${PX[v]}`;
      const m = v.match(SPACE); return m ? `gap-${m[1]}` : null;
    }
    case 'flex':
      if (is('1', "'1'")) return all.minWidth === '0' || all.minWidth === "'0'" ? 'grow' : 'flex-1';
      if (is("'1 1 auto'")) return 'flex-auto';
      return null;
    case 'minWidth':
      if (!is('0', "'0'")) return null;
      return (all.flex === '1' || all.flex === "'1'") ? '' : 'min-0';
    case 'flexShrink': return is('0', "'0'") ? 'shrink-0' : null;
    case 'width':
      if (is("'100%'")) return all.height === "'100%'" && all.objectFit === "'cover'" ? 'fill-cover' : 'w-full';
      { const m = v.match(TOKEN('control')); if (m && all.height === v) return `control-${m[1]}`; }
      return null;
    case 'height':
      if (is("'100%'")) return (all.width === "'100%'" && all.objectFit === "'cover'") || false ? '' : 'h-full';
      { const m = v.match(TOKEN('control')); if (m && all.width === v) return ''; }
      return null;
    case 'objectFit': return v === "'cover'" && all.width === "'100%'" && all.height === "'100%'" ? '' : null;
    case 'position': return is("'relative'") ? 'relative' : null;
    case 'overflow': return is("'hidden'") ? 'overflow-hidden' : null;
    case 'margin': return is('0', "'0'") ? 'm-0' : null;
    case 'marginTop': { if (is("'2px'", '2')) return 'mt-px'; if (PX[v]) return `mt-${PX[v]}`; const m = v.match(SPACE); return m && +m[1] <= 6 ? `mt-${m[1]}` : null; }
    case 'marginBottom': { if (PX[v]) return `mb-${PX[v]}`; const m = v.match(SPACE); return m && +m[1] <= 6 ? `mb-${m[1]}` : null; }
    case 'marginLeft': { if (is("'auto'")) return 'ml-auto'; if (is("'2px'", '2')) return 'ml-px'; const m = v.match(SPACE); return m && +m[1] <= 2 ? `ml-${m[1]}` : null; }
    case 'marginRight': { const m = v.match(SPACE); return m && +m[1] <= 2 ? `mr-${m[1]}` : null; }
    case 'padding': {
      if (is('0', "'0'")) return 'p-0';
      const px = PX[v]; if (px) return `p-${px}`;
      const m = v.match(SPACE); if (m) return `p-${m[1]}`;
      const two = v.match(/^'(0|var\(--space-([1-6])\)) (0|var\(--space-([1-6])\))'$/);
      if (two) return `py-${two[1] === '0' ? 0 : two[2]} px-${two[3] === '0' ? 0 : two[4]}`;
      return null;
    }
    case 'textAlign': return { "'center'": 'text-center', "'left'": 'text-left', "'right'": 'text-right' }[v] ?? null;
    case 'fontSize': {
      const m = v.match(TOKEN('text')); if (!m || !SIZES.includes(m[1])) return null;
      // Тройка кегль+межстрочье(+трекинг) одного шага → type-*.
      if (all.lineHeight === `'var(--leading-${m[1]})'`) return `type-${m[1]}`;
      return `text-${m[1]}`;
    }
    case 'lineHeight': {
      const m = v.match(TOKEN('leading')); if (!m) return null;
      if (all.fontSize === `'var(--text-${m[1]})'`) return '';
      return SIZES.includes(m[1]) || m[1] === 'relaxed' ? `leading-${m[1]}` : null;
    }
    case 'letterSpacing': {
      const m = v.match(TOKEN('tracking')); if (!m) return null;
      if (all.fontSize === `'var(--text-${m[1]})'` && all.lineHeight === `'var(--leading-${m[1]})'`) return '';
      return SIZES.includes(m[1]) ? `tracking-${m[1]}` : null;
    }
    case 'listStyle': return is("'none'") ? 'list-none' : null;
    case 'minHeight': return is('0', "'0'") ? 'min-h-0' : null;
    case 'maxWidth': return is("'100%'") ? 'max-w-full' : null;
    case 'paddingTop': { if (is("'2px'", '2')) return 'pt-px'; const m = v.match(SPACE); return m && +m[1] <= 5 ? `pt-${m[1]}` : null; }
    case 'paddingBottom': { const m = v.match(SPACE); return m && +m[1] <= 5 ? `pb-${m[1]}` : null; }
    case 'paddingLeft': { const m = v.match(SPACE); return m && +m[1] <= 4 ? `pl-${m[1]}` : null; }
    case 'paddingRight': { const m = v.match(SPACE); return m && +m[1] <= 4 ? `pr-${m[1]}` : null; }
    case 'border':
      if (is("'none'")) return 'border-none';
      return { "'1px solid var(--border-subtle)'": 'border-subtle', "'1px solid var(--border)'": 'border-line', "'1px solid var(--border-strong)'": 'border-strong' }[v] ?? null;
    case 'borderTop': return is("'1px solid var(--border-subtle)'") ? 'border-t-subtle' : null;
    case 'borderBottom': return is("'1px solid var(--border-subtle)'") ? 'border-b-subtle' : null;
    case 'background': case 'backgroundColor': {
      if (is("'none'")) return 'bg-none';
      if (is("'transparent'")) return 'bg-transparent';
      if (is("'var(--bg-base)'")) return 'bg-base';
      if (is("'var(--surface-sunken)'")) return 'bg-sunken';
      const sm = v.match(/^'var\(--surface-([1-4])\)'$/); if (sm) return `bg-surface-${sm[1]}`;
      return { "'var(--accent)'": 'bg-accent', "'var(--accent-soft)'": 'bg-accent-soft', "'var(--danger-soft)'": 'bg-danger-soft', "'var(--success-soft)'": 'bg-success-soft', "'var(--warning-soft)'": 'bg-warning-soft' }[v] ?? null;
    }
    case 'fontWeight': { const m = v.match(TOKEN('weight')); return m && ['normal', 'medium', 'semibold', 'bold'].includes(m[1]) ? `weight-${m[1]}` : null; }
    case 'color': {
      if (is("'inherit'")) return 'text-inherit';
      const t = v.match(TOKEN('text')); if (t && ['primary', 'secondary', 'muted', 'faint'].includes(t[1])) return `text-${t[1]}`;
      const o = v.match(/^'var\(--(accent|success|danger|warning)\)'$/); return o ? `text-${o[1]}` : null;
    }
    case 'fontVariantNumeric': return is("'tabular-nums'") ? 'tabular' : null;
    case 'borderRadius': { const m = v.match(TOKEN('radius')); return m && ['xs', 'sm', 'md', 'lg', 'full'].includes(m[1]) ? `radius-${m[1]}` : null; }
    case 'cursor': return is("'pointer'") ? 'pointer' : null;
    case 'pointerEvents': return is("'none'") ? 'no-events' : null;
    case 'whiteSpace': return is("'nowrap'") ? 'nowrap' : null;
    default: return null;
  }
}

/** Разбить тело объекта по запятым верхнего уровня. */
function splitPairs(body) {
  const out = []; let depth = 0, cur = '', q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === q && body[i - 1] !== '\\') q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Конец открывающего тега JSX с позиции `<`: индекс закрывающего `>`. */
function tagEnd(src, from) {
  let depth = 0, q = null;
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === q && src[i - 1] !== '\\') q = null; continue; }
    if (depth > 0 && (c === "'" || c === '"' || c === '`')) { q = c; continue; }
    if (c === '"' && depth === 0) { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

const STYLE_RE = /\sstyle=\{\{([^{}]*)\}\}/g;
let total = 0, converted = 0, removed = 0, partial = 0;
const perFile = [];

for (const file of roots.flatMap((r) => files(r))) {
  let src = readFileSync(file, 'utf8');
  let changed = false, fileCount = 0;
  // Идём с конца, чтобы индексы не плыли.
  const matches = [...src.matchAll(STYLE_RE)].reverse();
  for (const m of matches) {
    total++;
    const body = m[1];
    if (body.includes('...')) continue;
    const pairs = splitPairs(body);
    const all = {};
    const parsed = [];
    let ok = true;
    for (const pair of pairs) {
      const idx = pair.indexOf(':');
      if (idx < 0) { ok = false; break; }
      const key = pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      const value = pair.slice(idx + 1).trim();
      if (!/^[A-Za-z]+$/.test(key)) { ok = false; break; }
      all[key] = value; parsed.push({ key, value, raw: pair });
    }
    if (!ok || !parsed.length) continue;
    const classes = [], rest = [];
    for (const p of parsed) {
      const c = classFor(p.key, p.value, all);
      if (c === null) rest.push(p.raw); else if (c) classes.push(c);
    }
    // Пары, «учтённые» в другой (пустая строка), не должны оставаться, если их хозяин не перевёлся.
    const ownerMissing = parsed.some((p) => classFor(p.key, p.value, all) === '' && rest.some((r) => r.startsWith(p.key === 'flexDirection' || p.key === 'alignItems' ? 'display' : p.key === 'minWidth' ? 'flex' : p.key === 'height' || p.key === 'objectFit' ? 'width' : p.key === 'lineHeight' || p.key === 'letterSpacing' ? 'fontSize' : '§')));
    if (!classes.length || ownerMissing) continue;
    const start = m.index, end = m.index + m[0].length;
    const lt = src.lastIndexOf('<', start);
    if (lt < 0) continue;
    const gt = tagEnd(src, lt);
    if (gt < 0 || gt < end) continue;
    let tag = src.slice(lt, gt + 1);
    const relStart = start - lt, relEnd = end - lt;
    const newStyle = rest.length ? ` style={{ ${rest.join(', ')} }}` : '';
    const add = classes.join(' ');
    let cm;
    let replacedTag = null;
    if ((cm = tag.match(/className="([^"]*)"/))) {
      replacedTag = tag.replace(cm[0], `className="${cm[1] ? cm[1] + ' ' : ''}${add}"`);
    } else if ((cm = tag.match(/className=\{'([^']*)'\}/))) {
      replacedTag = tag.replace(cm[0], `className="${cm[1] ? cm[1] + ' ' : ''}${add}"`);
    } else if ((cm = tag.match(/className=\{`([^`]*)`\}/))) {
      replacedTag = tag.replace(cm[0], `className={\`${cm[1]} ${add}\`}`);
    } else if ((cm = tag.match(/className=\{(clsx|cn|classNames)\(/))) {
      const s0 = tag.indexOf(cm[0]); let d = 0, i = s0 + cm[0].length - 1;
      for (; i < tag.length; i++) { if (tag[i] === '(') d++; else if (tag[i] === ')') { d--; if (d === 0) break; } }
      if (i < tag.length) replacedTag = tag.slice(0, i) + `, '${add}'` + tag.slice(i);
    } else if (!/className=/.test(tag)) {
      replacedTag = tag.slice(0, relStart) + ` className="${add}"` + newStyle + tag.slice(relEnd);
      src = src.slice(0, lt) + replacedTag + src.slice(gt + 1);
      changed = true; fileCount++; converted++; if (rest.length) partial++; else removed++;
      continue;
    }
    if (!replacedTag) continue;
    // className заменён; теперь убрать/сократить style внутри обновлённого тега.
    const styleIdx = replacedTag.indexOf(m[0]);
    if (styleIdx < 0) continue;
    replacedTag = replacedTag.slice(0, styleIdx) + newStyle + replacedTag.slice(styleIdx + m[0].length);
    src = src.slice(0, lt) + replacedTag + src.slice(gt + 1);
    changed = true; fileCount++; converted++; if (rest.length) partial++; else removed++;
  }
  if (changed) { perFile.push([file, fileCount]); if (write) writeFileSync(file, src); }
}
console.log(`style={{}} всего: ${total}; переведено: ${converted} (целиком ${removed}, частично ${partial})${write ? ' — записано' : ' — пробный прогон'}`);
if (!write) perFile.sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([f, n]) => console.log(`  ${n}\t${f}`));
