/**
 * Своя обложка плейлиста.
 *
 * Плейлист и раньше показывал картинку — мозаику из четырёх обложек треков, —
 * но поставить свою было нельзя. Между тем именно по обложке плейлист и
 * узнают в списке: четыре одинаковых мозаики из одного и того же артиста
 * различаются хуже, чем любая своя картинка.
 *
 * Картинка хранится строкой data: в самой записи плейлиста. Это сознательный
 * размен: файл на диске пришлось бы переносить между устройствами вместе с
 * плейлистом и чистить при удалении, а обложка размером в пару десятков
 * килобайт лежит там же, где и всё остальное, и уезжает синхронизацией сама.
 * Ради этого она ужимается до {@link COVER_SIDE} пикселей — исходник с
 * телефона весит мегабайты, и класть их в базу нельзя.
 */

/** Сторона сохраняемой обложки. Крупнее её нигде не показывают. */
export const COVER_SIDE = 512;

/** Больше этого исходник даже не читается: это не обложка, а ошибка выбора. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** Качество JPEG. 0.82 — граница, за которой на обложке появляются квадраты. */
const COVER_QUALITY = 0.82;

/**
 * Готовит выбранный файл к хранению: квадрат {@link COVER_SIDE}, JPEG, data:.
 *
 * Обрезка по центру, а не сжатие в квадрат: вытянутая картинка, втиснутая в
 * квадрат, выглядит поломкой, а обрезанная — кадром.
 */
export async function prepareCoverImage(file: File): Promise<string> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Это не картинка');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('Картинка слишком большая — до 20 МБ');
  }

  const bitmap = await loadImage(file);
  const side = Math.min(bitmap.width, bitmap.height);
  if (!side) throw new Error('Не удалось прочитать картинку');

  const canvas = document.createElement('canvas');
  canvas.width = COVER_SIDE;
  canvas.height = COVER_SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось подготовить картинку');

  ctx.drawImage(
    bitmap as CanvasImageSource,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    COVER_SIDE,
    COVER_SIDE
  );

  return canvas.toDataURL('image/jpeg', COVER_QUALITY);
}

/**
 * Читает файл картинкой.
 *
 * `createImageBitmap` есть не везде — в jsdom его нет вовсе, — поэтому за ним
 * стоит обычный `Image` с object URL, и ссылка освобождается в обоих исходах.
 */
async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file);
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Не удалось прочитать картинку'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
