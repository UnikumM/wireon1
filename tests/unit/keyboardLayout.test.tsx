/**
 * Горячие клавиши и раскладка (4.0.2).
 *
 * Жалобы: «Ctrl+K не работает вообще» и «половина биндов не работает на
 * русской раскладке». Причина одна: сочетания сверяли `event.key` с латинской
 * буквой, а на кириллице клавиша K печатает «л». Вторая причина у Ctrl+K —
 * обработчик уходил раньше, если курсор стоял в поле ввода, а он почти всегда
 * стоит в поиске шапки.
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import '../setup';

import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { resetPlayerStore, resetUIStore } from '../helpers/testUtils';
import { isSlashKey, shortcutLetter } from '../../src/utils/physicalKey';
import { eventToAccelerator } from '../../src/utils/accelerators';

const Harness: React.FC = () => {
  useKeyboardShortcuts();
  return (
    <div>
      <input data-testid="field" type="text" />
      <div data-testid="page" tabIndex={-1} />
    </div>
  );
};

function press(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init } as KeyboardEvent;
}

describe('клавиша, а не буква на ней', () => {
  it('shortcutLetter: латиница как есть, кириллица — по месту клавиши', () => {
    expect(shortcutLetter({ key: 'k', code: 'KeyK' })).toBe('k');
    expect(shortcutLetter({ key: 'л', code: 'KeyK' })).toBe('k');
    expect(shortcutLetter({ key: 'Ь', code: 'KeyM' })).toBe('m');
    // Dvorak: на месте KeyV печатается «k» — человек жмёт клавишу с буквой.
    expect(shortcutLetter({ key: 'k', code: 'KeyV' })).toBe('k');
    // `code` пуст (старый WebView) — переводим по ЙЦУКЕН.
    expect(shortcutLetter({ key: 'л', code: '' })).toBe('k');
    expect(shortcutLetter({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBeNull();
    expect(shortcutLetter({ key: '1', code: 'Digit1' })).toBeNull();
  });

  it('isSlashKey: на русской раскладке клавиша «/» печатает точку', () => {
    expect(isSlashKey({ key: '/', code: 'Slash', shiftKey: false })).toBe(true);
    expect(isSlashKey({ key: '.', code: 'Slash', shiftKey: false })).toBe(true);
    // Shift+эта клавиша на русской — запятая, это уже не «поиск».
    expect(isSlashKey({ key: ',', code: 'Slash', shiftKey: true })).toBe(false);
    expect(isSlashKey({ key: 'z', code: 'Slash', shiftKey: false })).toBe(false);
  });

  it('запись глобального сочетания на русской раскладке даёт латинскую клавишу и знаки по месту', () => {
    expect(eventToAccelerator(press({ key: 'ь', code: 'KeyM', ctrlKey: true, altKey: true }))).toBe('CommandOrControl+Alt+M');
    // Клавиша «Х» стоит на месте «[» — раньше в систему уезжало `Ctrl+Alt+Х`.
    expect(eventToAccelerator(press({ key: 'х', code: 'BracketLeft', ctrlKey: true, altKey: true }))).toBe('CommandOrControl+Alt+[');
    // Без `code` кириллицу не записываем: такое сочетание система не поймёт.
    expect(eventToAccelerator(press({ key: 'х', code: '', ctrlKey: true, altKey: true }))).toBeNull();
  });
});

describe('горячие клавиши в русской раскладке', () => {
  beforeEach(() => {
    resetPlayerStore();
    resetUIStore();
  });

  it('Ctrl+Л (клавиша K) открывает палитру команд и закрывает её повторным нажатием', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.keyDown(getByTestId('page'), { key: 'л', code: 'KeyK', ctrlKey: true });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    fireEvent.keyDown(getByTestId('page'), { key: 'л', code: 'KeyK', ctrlKey: true });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it('Ctrl+K работает и когда курсор в поле ввода — а одиночные буквы там по-прежнему печатаются', () => {
    const toggleMute = vi.fn();
    usePlayerStore.setState({ toggleMute });
    const { getByTestId } = render(<Harness />);
    const field = getByTestId('field');
    field.focus();

    fireEvent.keyDown(field, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);

    fireEvent.keyDown(field, { key: 'ь', code: 'KeyM' });
    fireEvent.keyDown(field, { key: 'm', code: 'KeyM' });
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it('зажатая Ctrl+K не мигает палитрой', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.keyDown(getByTestId('page'), { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(getByTestId('page'), { key: 'k', code: 'KeyK', ctrlKey: true, repeat: true });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
  });

  it('одиночные буквы срабатывают по клавише: Ь → звук, А → на весь экран, Й → очередь', () => {
    const toggleMute = vi.fn();
    usePlayerStore.setState({ toggleMute });
    const { getByTestId } = render(<Harness />);
    const page = getByTestId('page');

    fireEvent.keyDown(page, { key: 'ь', code: 'KeyM' });
    expect(toggleMute).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(page, { key: 'а', code: 'KeyF' });
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);

    fireEvent.keyDown(page, { key: 'й', code: 'KeyQ' });
    expect(useUIStore.getState().isQueueOpen).toBe(true);
  });

  it('Alt+Ь (клавиша M) переключает мини-плеер', () => {
    const toggleMiniPlayer = vi.fn().mockResolvedValue(undefined);
    useUIStore.setState({ toggleMiniPlayer });
    const { getByTestId } = render(<Harness />);
    fireEvent.keyDown(getByTestId('page'), { key: 'ь', code: 'KeyM', altKey: true });
    expect(toggleMiniPlayer).toHaveBeenCalledTimes(1);
  });

  it('клавиша «/» ведёт в поиск, даже когда печатает точку', () => {
    const { getByTestId } = render(<Harness />);
    fireEvent.keyDown(getByTestId('page'), { key: '.', code: 'Slash' });
    expect(useUIStore.getState().activeView).toBe('search');
  });
});
