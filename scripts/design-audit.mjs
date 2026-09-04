/**
 * Ревизия оформления по исходникам.
 *
 * Ищет расхождения, которые не свалит ни один тест и не видно в одном файле:
 * тройки токенов, собранные из разных ступеней, размеры и слои числом, цвета и
 * длительности мимо темы, эмодзи вместо иконок, кнопки без подписи.
 *
 * Запускается руками — `node scripts/design-audit.mjs`. Это ревизор, а не
 * проверка: часть находок законна (образец цвета обязан быть литералом), поэтому
 * он печатает список для чтения, а не возвращает код ошибки.
 */
import fs from 'fs';
import path from 'path';

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|dist/.test(p)) walk(p);
    } else if (/\.(tsx|ts)$/.test(entry.name)) files.push(p);
  }
})('src');

const found = {
  triples: [],
  sizes: [],
  zIndex: [],
  px: [],
  colors: [],
  timing: [],
  shadows: [],
  weights: [],
  emoji: [],
  buttons: []
};

/**
 * Строки того же объекта стилей, что и строка `i`.
 *
 * Окно не фиксированной ширины: соседний объект со своими токенами давал ложные
 * срабатывания на тройках — кегль брался из одного, а межстрочное из следующего.
 * Границы ищутся по началу объекта (`style={{`, `= {`) и по его закрытию (`}}`,
 * `};`), потому что в разметке объект стилей закрывается двумя скобками, а не
 * точкой с запятой, и один пропущенный вид границы растягивал окно на весь файл.
 */
function styleScope(lines, i) {
  const opens = (line) => /style=\{\{|=\s*\{\s*$|:\s*React\.CSSProperties\s*=\s*\{/.test(line);
  const closes = (line) => /^\s*\}\}|^\s*\};|^\s*\}\)/.test(line);
  let from = i;
  while (from > 0 && !opens(lines[from]) && !closes(lines[from - 1])) from--;
  let to = i;
  while (to < lines.length - 1 && !closes(lines[to + 1]) && !opens(lines[to + 1])) to++;
  return lines.slice(from, to + 1).join('\n');
}

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = `${file}:${i + 1}`;
    const short = line.trim().slice(0, 86);

    // 1. Кегль без своей пары: `--text-lg` рядом с `--leading-sm` — ступени
    //    лестницы посчитаны вместе и по отдельности не сходятся.
    const size = line.match(/fontSize:\s*'var\(--text-([a-z0-9]+)\)'/);
    if (size) {
      const scope = styleScope(lines, i);
      for (const kind of ['leading', 'tracking']) {
        const other = scope.match(new RegExp(`--${kind}-([a-z0-9]+)[)]`));
        if (other && other[1] !== size[1]) found.triples.push(`${at}  text-${size[1]} + ${kind}-${other[1]}`);
      }
    }

    // 2. Размер иконки числом: лестница в styles/icons.ts.
    if (/<[A-Z][A-Za-z0-9]*[^>]*\bsize=\{\d+\}/.test(line) && !/Cover|Visualizer|Orb/.test(line)) {
      found.sizes.push(`${at}  ${short}`);
    }

    // 3. Слой числом. Мелкие 0…10 — порядок внутри одного компонента, лестница
    //    темы про него не знает; ищутся числа, которыми перекрывают всё окно.
    if (/zIndex:\s*\d{3}/.test(line)) found.zIndex.push(`${at}  ${short}`);

    // 4. Кегль и скругление числом. `50%` не в счёт: это круг, а не ступень
    //    лестницы, и пресет скруглений на аватарку влиять не должен.
    if (/(fontSize|borderRadius):\s*'?\d+px/.test(line)) found.px.push(`${at}  ${short}`);

    // 5. Цвет мимо палитры. Фирменные цвета сервисов пропускаются: зелёный
    //    Spotify — опознавательный знак чужого бренда, а не наше оформление, и
    //    подчиняться теме он не должен (объяснено в PLATFORM_CONFIG).
    if (
      /(color|background|backgroundColor|fill|stroke|borderColor):\s*'(#|rgb)/.test(line) &&
      !/on-media|data:image/.test(line) &&
      !/PlatformBadgeConfig/.test(styleScope(lines, i))
    ) {
      found.colors.push(`${at}  ${short}`);
    }

    // 6. Длительность и кривая числом: движение принадлежит теме, иначе один
    //    экран не слушается ни «меньше движения», ни ручки «Движение».
    if (!/var\(--(dur|ease)/.test(line)) {
      if (/transition[^:]*:\s*[`']([^`']*\b\d+(\.\d+)?m?s\b|[^`']*\b(ease|linear|ease-in|ease-out|ease-in-out)\b)/.test(line)) {
        found.timing.push(`${at}  ${short}`);
      }
      if (/animation[^:]*:\s*[`'][^`']*\d+(\.\d+)?m?s/.test(line)) found.timing.push(`${at}  ${short}`);
    }

    // 7. Тень числами.
    if (/(boxShadow|textShadow):\s*'[^']*(px|rgba)/.test(line) && !/var\(--/.test(line)) {
      found.shadows.push(`${at}  ${short}`);
    }

    // 8. Насыщенность числом — в том числе через условие (`isActive ? 600 : 500`).
    if (/fontWeight:[^,\n]*\d/.test(line)) found.weights.push(`${at}  ${short}`);

    // 9. Эмодзи в интерфейсе — вместо них иконки.
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(line)) found.emoji.push(`${at}  ${short}`);

    // 10. Кнопка без имени: голая иконка внутри и ни title, ни aria-label в
    //     пределах разметки — для чтения с экрана такая кнопка безымянная.
    if (/^\s*<button\b/.test(line)) {
      // Разметка кнопки ищется до её закрытия, а не в окне фиксированной высоты:
      // у карточек стиль занимает по двадцать строк, и подпись оказывалась за
      // краем окна — тогда ревизор объявлял безымянными четыре кнопки с текстом.
      let end = i;
      while (end < lines.length - 1 && end - i < 120 && !lines[end].includes('</button>')) end++;
      const tag = lines.slice(i, end + 1).join('\n').split('</button>')[0];
      const named = /(aria-label|title|aria-labelledby)[=]/.test(tag);
      // Подпись ищется так: сначала выкусываются выражения атрибутов — те, что
      // стоят после знака равенства (`onClick={() => …}`, `size={ICON.md}`), —
      // и только потом теги. Так остаётся содержимое кнопки: и живой текст, и
      // подпись через переменную `{label}`, которую читалка тоже озвучит.
      // Наивный поиск «текста после `>`» ловился на стрелке в onClick, а сплошное
      // выкусывание фигурных скобок — наоборот, съедало саму подпись.
      let bare = tag;
      for (let pass = 0; pass < 4; pass++) bare = bare.replace(/=\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');
      const textual = /[\p{L}\d]/u.test(bare.replace(/<[^>]*>/g, ' '));
      if (!named && !textual) found.buttons.push(`${at}  ${short}`);
    }
  }
}

let total = 0;
for (const [title, list] of Object.entries(found)) {
  total += list.length;
  console.log(`\n=== ${title} (${list.length}) ===`);
  for (const item of list.slice(0, 40)) console.log(item);
  if (list.length > 40) console.log(`… и ещё ${list.length - 40}`);
}
console.log(`\nвсего находок: ${total}`);
