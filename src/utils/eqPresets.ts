import { EqSettings } from '../types/music';

/**
 * Пресеты эквалайзера.
 *
 * Полос всего три (низ ~120 Гц, середина ~1 кГц, верх ~6 кГц), поэтому пресеты
 * здесь честно скромные: это не «студийная кривая», а быстрый сдвиг тембра в
 * нужную сторону. Держим значения в пределах ±7 дБ — дальше начинает заметно
 * клиппировать на громких записях, а выравнивание громкости этого не спасает.
 */
export interface EqPreset {
  id: string;
  label: string;
  /** Одна строка для tooltip: что именно услышит человек. */
  description: string;
  gains: EqSettings;
}

export const EQ_PRESETS: EqPreset[] = [
  {
    id: 'flat',
    label: 'Ровно',
    description: 'Без обработки — так, как записано.',
    gains: { bass: 0, mid: 0, treble: 0 }
  },
  {
    id: 'bass',
    label: 'Больше баса',
    description: 'Плотный низ для хип-хопа и танцевального.',
    gains: { bass: 6, mid: -1, treble: 1 }
  },
  {
    id: 'vocal',
    label: 'Голос',
    description: 'Вперёд вокал и речь: для акустики и подкастов.',
    gains: { bass: -3, mid: 4, treble: 1 }
  },
  {
    id: 'electronic',
    label: 'Электроника',
    description: 'Подчёркнутые края, середина чуть назад.',
    gains: { bass: 5, mid: -2, treble: 4 }
  },
  {
    id: 'rock',
    label: 'Рок',
    description: 'Гитары и барабаны разборчивее, без гула.',
    gains: { bass: 3, mid: 1, treble: 3 }
  },
  {
    id: 'night',
    label: 'Тихий вечер',
    description: 'Убирает низ и верх, чтобы слушать негромко и не мешать.',
    gains: { bass: -4, mid: 2, treble: -3 }
  }
];

/**
 * Какой пресет сейчас включён, если это вообще пресет.
 *
 * Возвращает `null`, когда полосы двигали руками: тогда в интерфейсе не должна
 * гореть ни одна кнопка, иначе она врёт про то, что играет.
 */
export function matchEqPreset(eq: EqSettings): EqPreset | null {
  return (
    EQ_PRESETS.find(
      (preset) =>
        preset.gains.bass === eq.bass && preset.gains.mid === eq.mid && preset.gains.treble === eq.treble
    ) ?? null
  );
}
