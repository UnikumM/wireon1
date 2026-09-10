/**
 * Перевод нажатия в «сочетание», которое понимает система, и обратно в подпись.
 *
 * Электрон принимает сочетания строкой вида `CommandOrControl+Alt+Right`, а
 * человеку показывать надо `Ctrl + Alt + →`. Оба перевода живут здесь, потому
 * что ошибка в любом из них выглядит одинаково: клавиша нажимается, а ничего не
 * происходит — и непонятно, кто виноват, запись или регистрация.
 */

/** Клавиши, которые сами по себе сочетанием быть не могут. */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'Dead']);

/** Как называется клавиша в сочетании: слева — `event.key`, справа — имя для системы. */
const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
};

/** Подписи для показа: то же самое, но по-человечески. */
const HUMAN_NAMES: Record<string, string> = {
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Command: '⌘',
  Cmd: '⌘',
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
  Space: 'Пробел',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Return: 'Enter',
  Esc: 'Esc'
};

/**
 * Собирает сочетание из нажатия.
 *
 * `null` означает «это ещё не сочетание»: нажат один модификатор, или клавиша
 * вообще без модификаторов. Второе — намеренно: сочетание уровня системы
 * перехватывает клавишу у **всех** программ, и отдать ему одинокую букву
 * значит сломать набор текста везде.
 */
export function eventToAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (parts.length === 0) return null;

  const named = KEY_NAMES[event.key];
  if (named) {
    parts.push(named);
    return parts.join('+');
  }

  if (/^F\d{1,2}$/.test(event.key)) {
    parts.push(event.key);
    return parts.join('+');
  }

  if (event.key.length === 1) {
    // Буква приводится к верхнему регистру латиницей: система знает `A`, но не
    // знает `ф`, а раскладку в момент нажатия человек не выбирает.
    const code = /^Key([A-Z])$/.exec(event.code);
    const digit = /^Digit(\d)$/.exec(event.code);
    if (code) parts.push(code[1]);
    else if (digit) parts.push(digit[1]);
    else parts.push(event.key.toUpperCase());
    return parts.join('+');
  }

  return null;
}

/** Подпись сочетания для экрана настроек. */
export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return 'не назначено';
  return accelerator
    .split('+')
    .map((part) => HUMAN_NAMES[part] || part)
    .join(' + ');
}
