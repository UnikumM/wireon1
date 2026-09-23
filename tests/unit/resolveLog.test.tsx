/**
 * Журнал попыток на телефоне (`src/services/resolveLog.ts`) и ключ SoundCloud,
 * переживающий перезапуск (`src/services/soundcloud.ts`).
 *
 * Оба появились из одной жалобы: «на телефоне треки с SoundCloud сломаны и
 * грузятся очень долго». Разобрать её было нечем — журнала на телефоне не было,
 * — а медленным был как раз холодный старт: ключ SoundCloud жил только в памяти.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';

import {
  recordResolve,
  readResolveLog,
  clearResolveLog,
  formatResolveLog,
  resetResolveLogForTests,
  RESOLVE_LOG_KEY,
  RESOLVE_LOG_LIMIT
} from '../../src/services/resolveLog';
import { SoundCloudService } from '../../src/services/soundcloud';
import { ResolveLogSettings } from '../../src/components/settings/ResolveLogSettings';

const KEY = 'test_sc_client_id';
const GOOD_ID = 'a'.repeat(32);

describe('журнал попыток', () => {
  beforeEach(() => {
    localStorage.removeItem(RESOLVE_LOG_KEY);
    resetResolveLogForTests();
  });

  it('держит последние попытки и переживает перезапуск', () => {
    for (let i = 0; i < RESOLVE_LOG_LIMIT + 5; i++) {
      recordResolve({ source: 'soundcloud', title: `трек ${i}`, ms: 100, ok: true, detail: 'mp3' });
    }
    expect(readResolveLog()).toHaveLength(RESOLVE_LOG_LIMIT);
    expect(readResolveLog()[0].title).toBe('трек 5');

    resetResolveLogForTests();
    expect(readResolveLog()).toHaveLength(RESOLVE_LOG_LIMIT);
  });

  it('не хранит ссылки на поток: они длинные и никому не нужны в пересланном тексте', () => {
    recordResolve({
      source: 'youtube',
      title: 'x',
      ms: 1,
      ok: false,
      detail: 'HTTP 403 at https://rr3---sn.googlevideo.com/videoplayback?sig=SECRET'
    });
    expect(readResolveLog()[0].detail).toBe('HTTP 403 at <ссылка>');
  });

  it('копируется одной строкой на попытку', () => {
    recordResolve({ at: Date.UTC(2026, 8, 24, 1, 2, 3), source: 'soundcloud', title: 'Кино — Кукушка', ms: 25400, ok: false, detail: 'Source did not answer in time' });
    expect(formatResolveLog(readResolveLog())).toBe(
      '2026-09-24 01:02:03  FAIL  soundcloud  25.4 с  «Кино — Кукушка»  Source did not answer in time'
    );
  });

  it('экран диагностики показывает отказы и копирует журнал', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    recordResolve({ source: 'soundcloud', title: 'Кино — Кукушка', ms: 25400, ok: false, detail: 'Source did not answer in time' });
    recordResolve({ source: 'youtube', title: 'Кино — Группа крови', ms: 2100, ok: true, detail: 'm4a' });

    render(<ResolveLogSettings />);

    expect(screen.getByTestId('resolve-log-summary')).toHaveTextContent('Попыток: 2, не вышло: 1, дольше 10 секунд: 1.');
    expect(screen.getByText('Кино — Кукушка')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('resolve-log-copy'));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('FAIL  soundcloud  25.4 с'));

    act(() => clearResolveLog());
    expect(screen.getByTestId('resolve-log-summary')).toHaveTextContent('Пока пусто');
  });
});

describe('ключ SoundCloud между запусками', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it('сработавший ключ следующий запуск берёт сразу, без перебора и поиска', async () => {
    const first = new SoundCloudService({ persistKey: KEY, clientIds: ['b'.repeat(32)] });
    first.setClientId(GOOD_ID);

    const next = new SoundCloudService({ persistKey: KEY, clientIds: ['b'.repeat(32)] });
    expect(next.getCachedClientId()).toBe(GOOD_ID);
    expect(await next.getClientId()).toBe(GOOD_ID);
  });

  it('просроченный или битый ключ не поднимается', () => {
    localStorage.setItem(KEY, JSON.stringify({ id: GOOD_ID, expiresAt: Date.now() - 1000 }));
    expect(new SoundCloudService({ persistKey: KEY }).getCachedClientId()).toBeNull();

    localStorage.setItem(KEY, JSON.stringify({ id: 'short', expiresAt: Date.now() + 1000 }));
    expect(new SoundCloudService({ persistKey: KEY }).getCachedClientId()).toBeNull();

    localStorage.setItem(KEY, '{не json');
    expect(new SoundCloudService({ persistKey: KEY }).getCachedClientId()).toBeNull();
  });

  it('отвергнутый ключ забывается: следующий запуск с него не начнёт', () => {
    const service = new SoundCloudService({ persistKey: KEY, clientIds: [GOOD_ID, 'c'.repeat(32)] });
    service.setClientId(GOOD_ID);
    expect(localStorage.getItem(KEY)).not.toBeNull();

    service.rotateClientId();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('без persistKey ничего не пишет — тестовые экземпляры не делят ключ', () => {
    new SoundCloudService().setClientId(GOOD_ID);
    expect(localStorage.getItem('wireon_soundcloud_client_id')).toBeNull();
  });
});
