/**
 * Перевод нажатия в «сочетание», которое понимает система, и обратно в подпись.
 *
 * Электрон принимает сочетания строкой вида `CommandOrControl+Alt+Right`, а
 * человеку показывать надо `Ctrl + Alt + →`. Оба перевода живут здесь, потому
 * что ошибка в любом из них выглядит одинаково: клавиша нажимается, а ничего не
 * происходит — и непонятно, кто виноват, запись или регистрация.
 */

/**
 * Клавиши, которые сами по себе сочетанием быть не могут.
 *
 * `Dead` здесь нет нарочно: так называет себя «мёртвая» клавиша (на macOS это
 * Alt+E, Alt+U), но место у неё обычное буквенное, и оно читается из `code`.
 */
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph']);

/**
 * Знаки препинания по месту клавиши: слева — `event.code`, справа — как клавишу
 * зовёт система. На русской раскладке на этих местах буквы (х, ъ, ж, э, б, ю,
 * ё), и в сочетание уезжало `Ctrl+Alt+Х` — строка, которую система не понимает.
 */
const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
};

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

  /*
   * Дальше — печатающие клавиши, и для них важно место, а не знак: раскладку в
   * момент нажатия человек не выбирает, а система знает `A`, но не знает `ф`.
   *
   * Латинская буква берётся как есть: на Dvorak и AZERTY она стоит не там, где
   * на QWERTY, и система ищет клавишу именно по букве. Всё остальное — кириллица,
   * значки от Alt и Shift, «мёртвые» клавиши — читается из `event.code`.
   */
  if (/^[a-zA-Z]$/.test(event.key)) {
    parts.push(event.key.toUpperCase());
    return parts.join('+');
  }

  const code = event.code || '';
  const physical =
    /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit(\d)$/.exec(code)?.[1] ?? PUNCTUATION_BY_CODE[code];
  if (physical) {
    parts.push(physical);
    return parts.join('+');
  }

  // `code` пуст (старые WebView): верим знаку, но только тому, который система
  // поймёт. Буква не из латиницы сюда не проходит — лучше подождать другого
  // нажатия, чем записать сочетание, которое никогда не сработает.
  if (/^[!-~]$/.test(event.key)) {
    // Плюс разделяет части сочетания, поэтому сам пишется словом.
    parts.push(event.key === '+' ? 'Plus' : event.key);
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
