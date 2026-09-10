/**
 * Запись сочетаний (`src/utils/accelerators.ts`).
 *
 * Проверяется то, из-за чего сочетание молча не работает: одинокая клавиша,
 * попавшая в глобальный перехват, и русская раскладка, из-за которой в систему
 * уезжает `Ф` вместо `A`.
 */

import { describe, it, expect } from 'vitest';
import { eventToAccelerator, formatAccelerator } from '../../src/utils/accelerators';

function press(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe('eventToAccelerator', () => {
  it('собирает сочетание из модификаторов и клавиши', () => {
    expect(eventToAccelerator(press({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true })))
      .toBe('CommandOrControl+Alt+Right');
    expect(eventToAccelerator(press({ key: ' ', code: 'Space', ctrlKey: true, altKey: true })))
      .toBe('CommandOrControl+Alt+Space');
    expect(eventToAccelerator(press({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true })))
      .toBe('CommandOrControl+Shift+P');
  });

  it('берёт букву из физической клавиши, а не из раскладки', () => {
    // Русская раскладка: `event.key` — «ф», а система знает только `A`.
    expect(eventToAccelerator(press({ key: 'ф', code: 'KeyA', ctrlKey: true, altKey: true })))
      .toBe('CommandOrControl+Alt+A');
  });

  it('не отдаёт сочетание без модификаторов', () => {
    // Иначе одна буква перехватывалась бы во всех программах сразу.
    expect(eventToAccelerator(press({ key: 'a', code: 'KeyA' }))).toBeNull();
    expect(eventToAccelerator(press({ key: ' ', code: 'Space' }))).toBeNull();
  });

  it('не считает сочетанием один модификатор', () => {
    expect(eventToAccelerator(press({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(eventToAccelerator(press({ key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('понимает функциональные клавиши', () => {
    expect(eventToAccelerator(press({ key: 'F7', code: 'F7', altKey: true }))).toBe('Alt+F7');
  });
});

describe('formatAccelerator', () => {
  it('показывает сочетание по-человечески', () => {
    expect(formatAccelerator('CommandOrControl+Alt+Right')).toBe('Ctrl + Alt + →');
    expect(formatAccelerator('CommandOrControl+Alt+Space')).toBe('Ctrl + Alt + Пробел');
  });

  it('честно говорит, когда клавиша не назначена', () => {
    expect(formatAccelerator('')).toBe('не назначено');
  });
});
