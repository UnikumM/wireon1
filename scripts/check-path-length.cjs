/**
 * Обрывает сборку, если внутрь пакета попал слишком длинный путь.
 *
 * Зачем. Установщик NSIS обновляет приложение так: старая версия переносит свои
 * файлы во временную папку, и только потом кладутся новые. Перенос идёт через
 * обычные вызовы Windows, а у них предел — 260 символов на путь. Временная папка
 * длиннее папки установки, поэтому файл, который у нас лежит нормально, при
 * переносе за предел выходит — и перенос отказывает. Установщик пробует пять
 * раз, потом показывает «Не удалось закрыть Wireon» и выходит с кодом 2. Ни
 * слова про длину пути человек не видит: сообщение говорит совсем о другом.
 *
 * Так и случилось в 1.0.10. В зависимостях лежат пакеты Capacitor, а у них
 * внутри — папка `android`, куда Gradle складывает промежуточные файлы сборки
 * телефонного приложения. Имена там вроде
 * `verifyReleaseResources/compiled/anim_btn_radio_to_off_mtrl_dot_group_animation.xml.flat`.
 * Собранный APK притащил в настольную сборку две тысячи таких путей, и
 * обновление на компьютере перестало ставиться вовсе.
 *
 * Предел здесь строже системного: 200 символов от корня приложения. Разница —
 * запас на то, что человек поставит приложение не в стандартную папку, а глубже.
 */

const { readdirSync, statSync } = require('fs');
const path = require('path');

/**
 * Сколько символов пути отдаётся под саму папку установки и временную папку
 * переноса. Всё, что длиннее внутри пакета, до предела Windows не дотянет.
 */
const MAX_RELATIVE_LENGTH = 200;

/** Сколько примеров показать: список в тысячу строк никто читать не станет. */
const EXAMPLES_TO_SHOW = 5;

function collectLongPaths(root, dir = root, found = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const relative = path.relative(root, full);
    if (relative.length > MAX_RELATIVE_LENGTH) found.push(relative);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      // Ссылка в никуда мешать сборке не должна: её длину мы уже посчитали.
      continue;
    }
    if (stats.isDirectory()) collectLongPaths(root, full, found);
  }
  return found;
}

exports.default = async function checkPathLength(context) {
  const root = context.appOutDir;
  const long = collectLongPaths(root);
  if (long.length === 0) return;

  const longest = long.reduce((a, b) => (a.length >= b.length ? a : b));
  const examples = long
    .slice(0, EXAMPLES_TO_SHOW)
    .map((item) => `    ${item.length} символов: ${item}`)
    .join('\n');

  throw new Error(
    `В пакет попало ${long.length} путей длиннее ${MAX_RELATIVE_LENGTH} символов — ` +
      `установщик не сможет обновить приложение поверх такой версии.\n` +
      `  Самый длинный: ${longest.length} символов.\n${examples}\n` +
      `  Обычная причина — папка сборки телефонного приложения внутри node_modules. ` +
      `Исключите её в "files" в electron-builder.json.`
  );
};
