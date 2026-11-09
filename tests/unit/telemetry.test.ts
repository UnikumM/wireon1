import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup';
import {
  flushTelemetry,
  pendingTelemetryForTests,
  resetTelemetryForTests,
  scrubDetail,
  sendUserReport,
  setTelemetryEnabled,
  trackResolve
} from '../../src/services/telemetry';

/**
 * Договор с пользователями: адреса не уходят никогда, у удачной загрузки нет
 * ни трека, ни текста, выключатель выключает, а пропавший сервер не теряет
 * накопленное.
 */

const CONFIG = { baseUrl: 'http://music.example:25545', token: 'tok' };

beforeEach(() => {
  resetTelemetryForTests();
  setTelemetryEnabled(true);
});

describe('telemetry', () => {
  it('из текста вырезаются ссылки и адреса', () => {
    const clean = scrubDetail(
      'default: URL rejected https://rr1.googlevideo.com/videoplayback?ip=41.66.99.238 via 10.1.2.3 C:\\Users\\someone\\AppData'
    );
    expect(clean).not.toMatch(/41\.66|10\.1\.2\.3|googlevideo|someone/);
  });

  it('удачная загрузка — без трека и без текста', () => {
    trackResolve({ ok: true, source: 'youtube', ms: 300, detail: 'm4a', videoId: 'dQw4w9WgXcQ' });
    const [event] = pendingTelemetryForTests();
    expect(event.videoId).toBeUndefined();
    expect(event.detail).toBeUndefined();
  });

  it('у отказа есть код, текст и трек', () => {
    trackResolve({ ok: false, source: 'youtube', ms: 9000, detail: 'YT_BOT_CHECK: not a bot', videoId: 'kJQP7kiw5Fk' });
    expect(pendingTelemetryForTests()[0]).toMatchObject({ code: 'YT_BOT_CHECK', videoId: 'kJQP7kiw5Fk' });
  });

  it('выключенная статистика ничего не копит и не шлёт', async () => {
    setTelemetryEnabled(false);
    trackResolve({ ok: false, source: 'youtube', ms: 1, detail: 'X_Y: z' });
    const fetchSpy = vi.fn();
    await flushTelemetry(fetchSpy as unknown as typeof fetch, CONFIG);
    expect(pendingTelemetryForTests()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('отправка — токеном в заголовке, с идентификатором установки', async () => {
    trackResolve({ ok: true, source: 'soundcloud', ms: 200 });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    await flushTelemetry(fetchSpy as unknown as typeof fetch, CONFIG);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://music.example:25545/v1/telemetry');
    expect((init.headers as Record<string, string>)['X-Wireon-Token']).toBe('tok');
    const body = JSON.parse(String(init.body));
    expect(body.install).toMatch(/^[A-Za-z0-9-]{8,}$/);
    expect(body.events).toHaveLength(1);
    expect(pendingTelemetryForTests()).toHaveLength(0);
  });

  it('сервер недоступен — события остаются в очереди', async () => {
    trackResolve({ ok: false, source: 'youtube', ms: 1, detail: 'A_B: c' });
    await flushTelemetry((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch, CONFIG);
    expect(pendingTelemetryForTests()).toHaveLength(1);
    resetTelemetryForTests();
  });
});

describe('отчёт от пользователя', () => {
  it('уходит сразу, с кодом, треком и версией, даже при выключенной статистике', async () => {
    setTelemetryEnabled(false);
    const fetchSpy = vi.fn(async () => new Response('{}'));
    const sent = await sendUserReport(
      {
        message: 'YouTube не отдал аудио.',
        detail: "Error invoking remote method 'resolve-youtube-stream': Error: YT_BOT_CHECK: see https://x.y/z?ip=1.2.3.4",
        trackId: 'yt_abc123',
        source: 'youtube'
      },
      fetchSpy as unknown as typeof fetch,
      CONFIG
    );

    expect(sent).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://music.example:25545/v1/telemetry');
    const body = JSON.parse(String(init.body));
    expect(body.version).toBeTruthy();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'report', ok: false, source: 'youtube', code: 'YT_BOT_CHECK', videoId: 'yt_abc123' });
    expect(body.events[0].detail).toContain('YouTube не отдал аудио.');
    expect(body.events[0].detail).not.toMatch(/1\.2\.3\.4|x\.y/);
    // Отчёт — не фоновое событие: в очередь он не ложится.
    expect(pendingTelemetryForTests()).toHaveLength(0);
  });

  it('без сервера или при отказе сервера возвращает false', async () => {
    expect(await sendUserReport({ message: 'x' }, vi.fn() as unknown as typeof fetch, null)).toBe(false);
    const refusing = vi.fn(async () => new Response('no', { status: 500 }));
    expect(await sendUserReport({ message: 'x' }, refusing as unknown as typeof fetch, CONFIG)).toBe(false);
  });
});
