import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { resolveVisionos, resetVisionosVisitor } from '../../electron/visionosDirect';
import { StreamResolver } from '../../electron/streamResolver';

/**
 * Быстрая ступень десктопа: один запрос /player вместо пяти-десяти секунд
 * Python. Ломается она молча в трёх местах — без visitorData (YouTube тогда
 * требует «вы не робот» на всё), в разборе форм (ссылка теряется) и в порядке
 * лестницы (её 403 должен вести к yt-dlp, а не к отказу).
 */

const VIDEO_ID = 'dQw4w9WgXcQ';

function youtube(player: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (!init?.method) return new Response('<script>{"VISITOR_DATA":"vis42"}</script>');
    return new Response(JSON.stringify(player));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => resetVisionosVisitor());

describe('visionosDirect', () => {
  it('шлёт visitorData и отдаёт звуковые дорожки в форме yt-dlp', async () => {
    const { fetchImpl, calls } = youtube({
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          { mimeType: 'video/mp4; codecs="avc1"', bitrate: 900000, url: 'https://v' },
          { mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, url: 'https://a.m4a' },
          { mimeType: 'audio/webm; codecs="opus"', bitrate: 140000, signatureCipher: 's=x' }
        ]
      }
    });

    const info = await resolveVisionos(VIDEO_ID, fetchImpl, 0);

    expect(info.formats).toEqual([
      { url: 'https://a.m4a', ext: 'm4a', abr: 130, acodec: 'mp4a.40.2', vcodec: 'none', protocol: 'https' }
    ]);
    const player = calls.find((c) => c.init?.method === 'POST')!;
    expect((player.init!.headers as Record<string, string>)['X-Goog-Visitor-Id']).toBe('vis42');
    expect(JSON.parse(String(player.init!.body)).context.client.clientName).toBe('VISIONOS');
  });

  it('visitorData берётся один раз, а не на каждый трек', async () => {
    const { fetchImpl, calls } = youtube({ playabilityStatus: { status: 'OK' }, streamingData: {} });
    await resolveVisionos(VIDEO_ID, fetchImpl, 0);
    await resolveVisionos(VIDEO_ID, fetchImpl, 1000);
    expect(calls.filter((c) => !c.init?.method)).toHaveLength(1);
  });

  it('«вы не робот» — текстом yt-dlp и со свежим visitorData в следующий раз', async () => {
    const { fetchImpl, calls } = youtube({
      playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' }
    });
    await expect(resolveVisionos(VIDEO_ID, fetchImpl, 0)).rejects.toThrow(/^ERROR: \[youtube\] .*not a bot/);
    await expect(resolveVisionos(VIDEO_ID, fetchImpl, 1)).rejects.toThrow();
    expect(calls.filter((c) => !c.init?.method)).toHaveLength(2);
  });
});

describe('лестница десктопа с быстрой ступенью', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'wireon-visionos-'));
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  const info = (url: string) => ({ formats: [{ url, ext: 'm4a', abr: 128, acodec: 'mp4a', vcodec: 'none', protocol: 'https' }] });

  it('быстрая ступень прошла — yt-dlp не запускается вовсе', async () => {
    const ytdl = vi.fn();
    const direct = vi.fn().mockResolvedValue(info('https://fast.m4a'));
    const fetchImpl = vi.fn().mockResolvedValue({ status: 206, body: null }) as unknown as typeof fetch;

    const stream = await new StreamResolver({ ytdl, direct, fetchImpl, stateDir }).resolve(VIDEO_ID);

    expect(stream.streamUrl).toBe('https://fast.m4a');
    expect(ytdl).not.toHaveBeenCalled();
  });

  it('её ссылка не прошла проверку — дальше обычный yt-dlp', async () => {
    const ytdl = vi.fn().mockResolvedValue(info('https://slow.m4a'));
    const direct = vi.fn().mockResolvedValue(info('https://fast.m4a'));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, body: null })
      .mockResolvedValueOnce({ status: 206, body: null }) as unknown as typeof fetch;

    const stream = await new StreamResolver({ ytdl, direct, fetchImpl, stateDir }).resolve(VIDEO_ID);

    expect(stream.streamUrl).toBe('https://slow.m4a');
    expect(ytdl).toHaveBeenCalledTimes(1);
  });

  it('её отказ — не конец лестницы', async () => {
    const ytdl = vi.fn().mockResolvedValue(info('https://slow.m4a'));
    const direct = vi.fn().mockRejectedValue(new Error('visionos: на главной YouTube нет VISITOR_DATA'));
    const fetchImpl = vi.fn().mockResolvedValue({ status: 206, body: null }) as unknown as typeof fetch;

    const stream = await new StreamResolver({ ytdl, direct, fetchImpl, stateDir }).resolve(VIDEO_ID);
    expect(stream.streamUrl).toBe('https://slow.m4a');
  });
});
