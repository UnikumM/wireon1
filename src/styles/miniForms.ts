/**
 * Формы мини-плеера.
 *
 * Облик (`miniSkins.ts`) красит, форма — строит. Раньше вариант был один:
 * прямоугольник, который человек тянул за край, и на узком окне ползунок
 * громкости и подписи уезжали за край. Теперь размер задаёт форма, и каждая
 * нарисована под свой размер: на ней всё помещается, потому что другого размера у
 * неё не бывает.
 *
 * Окно прозрачное, форма — фигура внутри него. Поле вокруг фигуры нужно под тень
 * и свечение и пропускает клики к окнам под ним. Прозрачное окно в Electron
 * нельзя тянуть за край — это ещё одна причина, по которой размер фиксирован.
 *
 * Размеры окна дублируются в `electron/main.ts`: главный процесс собирается
 * отдельно и из `src` не импортирует. Совпадение проверяется тестом.
 */

export const MINI_FORM_IDS = ['card', 'island', 'bar', 'cover', 'disc'] as const;

export type MiniFormId = (typeof MINI_FORM_IDS)[number];

export const DEFAULT_MINI_FORM_ID: MiniFormId = 'card';

export interface MiniForm {
  id: MiniFormId;
  name: string;
  hint: string;
  /** Размер окна: фигура плюс поле под тень. */
  window: { width: number; height: number };
}

export const MINI_FORMS: Record<MiniFormId, MiniForm> = {
  card: {
    id: 'card',
    name: 'Карточка',
    hint: 'Всё сразу: обложка, перемотка, громкость и ряд кнопок',
    window: { width: 372, height: 188 }
  },
  island: {
    id: 'island',
    name: 'Остров',
    hint: 'Узкая пилюля с эквалайзером; при наведении раскрывается в плеер',
    window: { width: 412, height: 212 }
  },
  bar: {
    id: 'bar',
    name: 'Полоса',
    hint: 'Одна строка: обложка, название и три кнопки. Громкость — колёсиком',
    window: { width: 404, height: 100 }
  },
  cover: {
    id: 'cover',
    name: 'Обложка',
    hint: 'Квадрат-картинка; кнопки проступают поверх при наведении',
    window: { width: 240, height: 240 }
  },
  disc: {
    id: 'disc',
    name: 'Диск',
    hint: 'Круглая пластинка с кольцом прогресса, крутится, пока играет',
    window: { width: 208, height: 208 }
  }
};

export const MINI_FORM_LIST: readonly MiniForm[] = MINI_FORM_IDS.map((id) => MINI_FORMS[id]);

export function isMiniFormId(value: unknown): value is MiniFormId {
  return typeof value === 'string' && (MINI_FORM_IDS as readonly string[]).includes(value);
}
