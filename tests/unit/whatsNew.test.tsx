/**
 * Экран «Что нового» после обновления.
 *
 * Проверяется то, из-за чего такие экраны обычно и раздражают: показался ли он
 * ровно один раз, не встал ли поперёк первой установки, не пообещал ли того, чего
 * в сборке ещё нет, и закрывается ли всеми привычными способами.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../setup';

import {
  STORAGE_KEY_LAST_SEEN_VERSION,
  WhatsNewGate,
  WhatsNewSheet,
  decideWhatsNew,
  markVersionSeen,
  readLastSeenVersion
} from '../../src/components/common/WhatsNewGate';
import { STORAGE_KEY_INTRO_SEEN } from '../../src/components/auth/WelcomeGate';
import {
  CHANGELOG,
  ChangelogEntry,
  compareVersions,
  entriesSince,
  entryFor,
  formatEntryDate
} from '../../src/data/changelog';
import { APP_VERSION } from '../../src/utils/appInfo';

/** Своя история изменений: тесты не должны падать от правки настоящей. */
const FAKE: ChangelogEntry[] = [
  {
    version: '2.0.0',
    date: '2026-12-01',
    headline: 'Будущий выпуск',
    items: [{ kind: 'feature', title: 'Ещё не вышло' }]
  },
  {
    version: '1.1.0',
    date: '2026-09-01',
    headline: 'Свежий выпуск',
    items: [
      { kind: 'feature', title: 'Новая штука', detail: 'С подробностью' },
      { kind: 'fix', title: 'Починили' }
    ]
  },
  {
    version: '1.0.0',
    date: '2026-08-01',
    headline: 'Первый выпуск',
    items: [{ kind: 'change', title: 'Что-то поменяли' }]
  }
];

/** Отметка о том, что приложение уже запускалось: её ставит приветствие. */
function pretendRanBefore(): void {
  localStorage.setItem(STORAGE_KEY_INTRO_SEEN, '1');
}

describe('changelog: данные и отбор', () => {
  it('сравнивает версии по числам, а не по строкам', () => {
    // Строковое сравнение здесь дало бы «1.0.10» < «1.0.9».
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.3', '1.0.3')).toBe(0);
  });

  it('непонятную версию считает самой старой, а не ломается', () => {
    expect(compareVersions('не версия', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '')).toBeGreaterThan(0);
    expect(compareVersions('мусор', 'тоже мусор')).toBe(0);
  });

  it('отдаёт только непрочитанное', () => {
    const list = entriesSince('1.0.0', '1.1.0', FAKE);

    expect(list.map((e) => e.version)).toEqual(['1.1.0']);
  });

  it('не обещает того, чего в этой сборке нет', () => {
    // Запись про 2.0.0 лежит в файле заранее — показывать её нельзя.
    const list = entriesSince('1.0.0', '1.1.0', FAKE);

    expect(list.some((e) => e.version === '2.0.0')).toBe(false);
  });

  it('складывает несколько пропущенных выпусков, от новых к старым', () => {
    const list = entriesSince('0.9.0', '1.1.0', FAKE);

    expect(list.map((e) => e.version)).toEqual(['1.1.0', '1.0.0']);
  });

  it('без прошлой версии не показывает ничего', () => {
    expect(entriesSince(null, '1.1.0', FAKE)).toEqual([]);
  });

  it('на той же версии молчит', () => {
    expect(entriesSince('1.1.0', '1.1.0', FAKE)).toEqual([]);
  });

  it('находит запись про конкретную версию', () => {
    expect(entryFor('1.1.0', FAKE)?.headline).toBe('Свежий выпуск');
    expect(entryFor('1.5.0', FAKE)).toBeNull();
  });

  it('дата читается по-русски, а мусор остаётся как есть', () => {
    expect(formatEntryDate('2026-08-22')).toContain('2026');
    expect(formatEntryDate('когда-нибудь')).toBe('когда-нибудь');
  });

  it('настоящая история описывает текущую сборку', () => {
    // Иначе обновление выйдет с пустым экраном «Что нового».
    expect(entryFor(APP_VERSION)).not.toBeNull();
    // И каждая запись пригодна для сравнения версий.
    for (const entry of CHANGELOG) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.items.length).toBeGreaterThan(0);
    }
  });
});

describe('decideWhatsNew: кому показывать', () => {
  it('свежей установке — молча запомнить версию', () => {
    const decision = decideWhatsNew({ lastSeen: undefined, currentVersion: '1.1.0', ranBefore: false });

    expect(decision.entries).toEqual([]);
    expect(decision.shouldRecord).toBe(true);
  });

  it('обновлению со сборки без этой памяти — показать всё, что знаем', () => {
    const decision = decideWhatsNew({ lastSeen: undefined, currentVersion: APP_VERSION, ranBefore: true });

    expect(decision.entries.length).toBeGreaterThan(0);
    expect(decision.entries[0].version).toBe(APP_VERSION);
  });

  it('при недоступном хранилище не показывает и не пишет', () => {
    const decision = decideWhatsNew({ lastSeen: null, currentVersion: '1.1.0', ranBefore: true });

    expect(decision.entries).toEqual([]);
    expect(decision.shouldRecord).toBe(false);
  });

  it('тому, кто уже читал эту версию, — ничего', () => {
    const decision = decideWhatsNew({ lastSeen: APP_VERSION, currentVersion: APP_VERSION, ranBefore: true });

    expect(decision.entries).toEqual([]);
    expect(decision.shouldRecord).toBe(true);
  });
});

describe('WhatsNewGate: показ после обновления', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('после обновления показывает лист и запоминает версию', () => {
    pretendRanBefore();
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');

    render(<WhatsNewGate />);

    expect(screen.getByTestId('whats-new-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-sheet')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: `Wireon Sounds ${APP_VERSION}` })).toBeInTheDocument();
    // Версия записывается сразу, а не после закрытия: приложение могли закрыть
    // прямо с открытым листом, и тогда он встал бы снова.
    expect(localStorage.getItem(STORAGE_KEY_LAST_SEEN_VERSION)).toBe(APP_VERSION);
  });

  it('на той же версии второй раз не показывается', () => {
    pretendRanBefore();
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, APP_VERSION);

    render(<WhatsNewGate />);

    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
  });

  it('не встаёт поперёк первого запуска', () => {
    // Ни отметки о версии, ни следа приветствия — человек видит Wireon впервые.
    render(<WhatsNewGate />);

    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
    // Но версия запоминается, иначе первое же обновление покажет всю историю.
    expect(localStorage.getItem(STORAGE_KEY_LAST_SEEN_VERSION)).toBe(APP_VERSION);
  });

  it('обновившемуся со старой сборки показывает историю', () => {
    // Отметки о версии нет, но приложение уже запускалось.
    pretendRanBefore();

    render(<WhatsNewGate />);

    expect(screen.getByTestId('whats-new-sheet')).toBeInTheDocument();
    expect(screen.getByTestId(`whats-new-entry-${APP_VERSION}`)).toBeInTheDocument();
  });

  it('закрывается кнопкой и больше не возвращается', () => {
    pretendRanBefore();
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');

    const { unmount } = render(<WhatsNewGate />);
    fireEvent.click(screen.getByTestId('whats-new-continue'));

    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY_LAST_SEEN_VERSION)).toBe(APP_VERSION);

    unmount();
    render(<WhatsNewGate />);
    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
  });

  it('закрывается крестиком, Escape и кликом по фону', () => {
    pretendRanBefore();
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');

    const { unmount } = render(<WhatsNewGate />);
    fireEvent.click(screen.getByTestId('whats-new-close'));
    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
    unmount();

    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');
    const second = render(<WhatsNewGate />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
    second.unmount();

    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');
    render(<WhatsNewGate />);
    const overlay = screen.getByTestId('whats-new-overlay');
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
  });

  it('клик внутри листа его не закрывает', () => {
    pretendRanBefore();
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, '0.9.0');

    render(<WhatsNewGate />);
    const sheet = screen.getByTestId('whats-new-sheet');
    fireEvent.mouseDown(sheet);
    fireEvent.click(sheet);

    expect(screen.getByTestId('whats-new-sheet')).toBeInTheDocument();
  });

  it('без работающего localStorage не показывается и не падает', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('The operation is insecure.');
    });

    expect(readLastSeenVersion()).toBeNull();
    expect(() => markVersionSeen()).not.toThrow();

    render(<WhatsNewGate />);
    expect(screen.queryByTestId('whats-new-sheet')).not.toBeInTheDocument();
  });
});

describe('WhatsNewSheet: содержимое', () => {
  afterEach(() => {
    cleanup();
  });

  it('показывает заголовок выпуска, пункты и подробности', () => {
    render(<WhatsNewSheet entries={[FAKE[1]]} onClose={() => {}} />);

    expect(screen.getByTestId('whats-new-headline')).toHaveTextContent('Свежий выпуск');
    expect(screen.getByText('Новая штука')).toBeInTheDocument();
    expect(screen.getByText('С подробностью')).toBeInTheDocument();
    expect(screen.getByText('Починили')).toBeInTheDocument();
  });

  it('каждый пункт подписан типом — иконка одна для читателя не значит ничего', () => {
    render(<WhatsNewSheet entries={[FAKE[1]]} onClose={() => {}} />);

    expect(screen.getByLabelText('Новое')).toBeInTheDocument();
    expect(screen.getByLabelText('Исправлено')).toBeInTheDocument();
  });

  it('несколько пропущенных выпусков разделены заголовками версий', () => {
    render(<WhatsNewSheet entries={[FAKE[1], FAKE[2]]} onClose={() => {}} />);

    expect(screen.getByTestId('whats-new-entry-1.1.0')).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-entry-1.0.0')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
  });

  it('на пустом списке не притворяется, что что-то изменилось', () => {
    render(<WhatsNewSheet entries={[]} onClose={() => {}} />);

    expect(screen.getByRole('heading', { name: `Wireon Sounds ${APP_VERSION}` })).toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-headline')).not.toBeInTheDocument();
  });

  it('сообщает о закрытии тому, кто его открыл', () => {
    const onClose = vi.fn();
    render(<WhatsNewSheet entries={[FAKE[1]]} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('whats-new-continue'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
