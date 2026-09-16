/**
 * Обработка звука на телефоне: эквалайзер, спектр, кроссфейд.
 *
 * Почему это настройка, а не просто «работает»
 * --------------------------------------------
 * Web Audio отказывается пропускать через себя «запятнанный» ресурс: звук идёт,
 * а из графа выходит тишина. Ссылки YouTube отдаёт с `googlevideo.com` **без
 * заголовков CORS** — проверено на живой ссылке 2026-09-16: ни `Access-Control-
 * Allow-Origin` в ответе, ни ответа на предзапрос. Значит, прямой поток на
 * телефоне через эквалайзер пропустить нельзя, и до сих пор граф там не
 * строился вовсе.
 *
 * Чистый источник у телефона один — свой файл: то, что лежит рядом и отдаётся
 * схемой самого WebView, запятнанным не считается. Поэтому при включённой
 * обработке трек сначала забирается в кэш целиком (родным слоем, мимо правил
 * страницы), а играет уже файл. Цена честная и написана в настройке: трек
 * начинается на несколько секунд позже.
 *
 * Почему «прилипает»
 * ------------------
 * `createMediaElementSource` привязывает элемент к графу навсегда: отвязать его
 * обратно нельзя. Если после включения обработку выключить, элемент останется в
 * графе, и прямой поток через него станет тишиной. Поэтому выключение убирает
 * только саму обработку (полосы становятся ровными), а источником до перезапуска
 * остаётся файл.
 */

export type AudioProcessingListener = (enabled: boolean) => void;

let enabled = false;
/** Граф уже привязан к элементам в этом запуске — назад дороги нет. */
let sticky = false;
const listeners = new Set<AudioProcessingListener>();

/** Включена ли обработка звука сейчас. */
export function isAudioProcessingEnabled(): boolean {
  return enabled;
}

/**
 * Нужен ли проигрывателю файл вместо прямой ссылки.
 *
 * Остаётся `true` после выключения обработки: элемент уже в графе, и прямой
 * поток он отдал бы тишиной.
 */
export function needsLocalSource(): boolean {
  return enabled || sticky;
}

export function setAudioProcessingEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  if (next) sticky = true;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch (err) {
      console.warn('[AudioProcessing] listener failed:', err);
    }
  }
}

export function onAudioProcessingChange(listener: AudioProcessingListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetAudioProcessingForTests(): void {
  enabled = false;
  sticky = false;
  listeners.clear();
}
