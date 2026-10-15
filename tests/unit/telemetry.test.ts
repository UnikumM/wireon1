import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup';
import {
  flushTelemetry,
  pendingTelemetryForTests,
  resetTelemetryForTests,
  scrubDetail,
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
      'default: URL rejected https://rr1.googlevideo.com/videoplayback?ip=41.66.99.238 via 10.1.2.3 C:\\Users\\vvedi\\AppData'
    );
    expect(clean).not.toMatch(/41\.66|10\.1\.2\.3|googlevideo|vvedi/);
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
