/**
 * Ссылка на аудио одним запросом /player от имени клиента `visionos` — без yt-dlp.
 *
 * Зачем. yt-dlp на каждую попытку поднимает Python: 5–10 секунд, а когда первый
 * клиент выдаёт ссылку с 403 и лестница идёт дальше — 20–60 секунд до звука
 * (журналы владельца, 15.10). `visionos` — тот же клиент, что yt-dlp выбирает
 * сам: отдаёт готовые ссылки (`REQUIRE_JS_PLAYER: False`), без расшифровки и
 * без PO-токена. Замерено 2026-10-14: 30/30 треков скачались целиком.
 *
 * Обязательное условие — visitorData с главной: без него тот же запрос получает
 * «вы не робот». Значения клиента — из `yt_dlp/extractor/youtube/_base.py`;
 * перестанет работать — сверить там. Ответ в форме yt-dlp (`formats[]`), чтобы
 * выбор дорожки и проверка ссылки оставались общими с остальной лестницей.
 */

const CLIENT = {
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  deviceMake: 'Apple',
  deviceModel: 'RealityDevice17,1',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  osName: 'visionOS',
  osVersion: '26.5.23O471',
  hl: 'en',
  gl: 'US'
};
const CLIENT_ID = '101';
/** visitorData живёт долго, но не вечно: раз в шесть часов берём свежий. */
const VISITOR_TTL_MS = 6 * 60 * 60 * 1000;

let visitor: { value: string; at: number } | null = null;

/** Сброс запомненного visitorData. Нужен тестам и после «вы не робот». */
export function resetVisionosVisitor(): void {
  visitor = null;
}

async function visitorData(fetchImpl: typeof fetch, now: number): Promise<string> {
  if (visitor && now - visitor.at < VISITOR_TTL_MS) return visitor.value;
  const page = await fetchImpl('https://www.youtube.com/', {
    headers: { 'User-Agent': CLIENT.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(10000)
  });
  const value = (await page.text()).match(/"VISITOR_DATA":"([^"]+)"/)?.[1];
  if (!value) throw new Error('visionos: на главной YouTube нет VISITOR_DATA');
  visitor = { value, at: now };
  return value;
}

function extOf(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  return 'm4a';
}

/**
 * Ответ /player в форме yt-dlp. Отказ — `Error` с текстом YouTube, чтобы
 * общая классификация (`classifyResolveError`, «вы не робот») работала как для
 * yt-dlp.
 */
export async function resolveVisionos(
  videoId: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<{ formats: Array<Record<string, unknown>> }> {
  const visitorId = await visitorData(fetchImpl, now);
  const response = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': CLIENT.userAgent,
      'X-YouTube-Client-Name': CLIENT_ID,
      'X-YouTube-Client-Version': CLIENT.clientVersion,
      'X-Goog-Visitor-Id': visitorId,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({
      context: { client: { ...CLIENT, visitorData: visitorId } },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`visionos: YouTube /player ответил ${response.status}`);
  const player = (await response.json()) as any;

  const status = String(player?.playabilityStatus?.status || '');
  if (status !== 'OK') {
    const reason = String(player?.playabilityStatus?.reason || status || 'нет статуса');
    if (/not a bot/i.test(reason)) resetVisionosVisitor();
    // Текст как у yt-dlp — его ловят те же шаблоны терминальных отказов.
    throw new Error(`ERROR: [youtube] ${videoId}: ${reason}`);
  }

  const formats = (player?.streamingData?.adaptiveFormats || [])
    .filter((f: any) => typeof f?.url === 'string' && String(f?.mimeType || '').startsWith('audio/'))
    .map((f: any) => {
      const mime = String(f.mimeType);
      return {
        url: f.url,
        ext: extOf(mime),
        abr: Math.round((Number(f.averageBitrate || f.bitrate) || 0) / 1000),
        acodec: /codecs="([^"]+)"/.exec(mime)?.[1] || 'unknown',
        vcodec: 'none',
        protocol: 'https'
      };
    });
  return { formats };
}
