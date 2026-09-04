package pro.wireon.music;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.mapper.VideoFormat;
import com.yausername.youtubedl_android.mapper.VideoInfo;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * yt-dlp, работающий на самом телефоне.
 *
 * Зачем он здесь, если тот же yt-dlp уже стоит на сервере: у сервера адрес
 * дата-центра, один на всех, и YouTube требует у него доказать, что он не
 * робот, практически на каждый трек. Обойти это можно только чужими cookies,
 * которые протухают за недели и требуют ручного обновления. У телефона адрес
 * домашний — той же проверки на нём нет, ровно как её нет у настольной сборки,
 * где yt-dlp живёт с самого начала и работает без единой cookie.
 *
 * Почему не `youtubei.js`, который уже лежит в сборке: замерено 2026-08-28 —
 * ни один его клиент не отдаёт ни прямой ссылки, ни манифеста, только
 * `server_abr_streaming_url`. Играть такое `<audio src>` не умеет. yt-dlp
 * прямую ссылку получает, потому что умеет то, чего youtubei.js пока не умеет.
 *
 * Здесь живут три вещи, каждая из которых чинит свою беду, замеренную на
 * эмуляторе 2026-09-01:
 *
 * 1. **Две полосы вместо одной очереди.** Раньше все разборы шли одним потоком
 *    по порядку поступления. Плеер греет три следующих трека, каждый разбор —
 *    секунды, и нажатие play вставало за ними: замерено **25,5 с** ожидания
 *    там, где сам разбор занимает шесть. Веб-часть при этом бросает попытку по
 *    сроку, то есть человек видел ошибку ровно тогда, когда всё работало, — а
 *    через минуту тот же трек играл, потому что фоновый разбор к тому времени
 *    уже лёг в кэш. Отсюда «иногда ошибка, а потом само». Теперь у человека
 *    своя полоса, и фон он не ждёт никогда.
 * 2. **Перебор клиентов.** YouTube привязывает часть форматов к
 *    proof-of-origin: ссылка выдаётся, отвечает на запрос — и молчит в плеере.
 *    Разные клиенты отдают разные наборы форматов, поэтому перебор — ровно то,
 *    что превращает «половина песен не играет» в «песни играют». Настольная
 *    сборка так делает с самого начала; телефон делал одну попытку.
 * 3. **Проверка ссылки тем же запросом, что сделает плеер** — `Range: bytes=0-`,
 *    открытый диапазон. Ограниченный (`bytes=0-1`) обманчив: перекрытая ссылка
 *    отвечает на него 206 и отказывает уже в плеере. Снаружи это выглядело как
 *    «этот аудиоформат здесь не воспроизводится», то есть как беда с треком.
 *
 * Ни один метод не бросает наружу: отказ разбора обязан остаться отказом
 * одного трека, а не падением приложения посреди прослушивания.
 */
@CapacitorPlugin(name = "YtDlp")
public class YtDlpPlugin extends Plugin {

    private static final String TAG = "WireonYtDlp";

    /**
     * Одна ступень перебора: как назвать в журнале и каким клиентом YouTube
     * представиться.
     *
     * Порядок повторяет настольный и проверен замером 2026-09-01: `default` и
     * `visionos` отдают `m4a` и проходят проверку, `tv` и `tv_downgraded`
     * отказывают сразу («The page needs to be reloaded») и потому стоят дёшево,
     * а `web_safari` держится последним — он отдаёт склеенный HLS, который
     * играется только через hls.js.
     */
    private static final String[][] ATTEMPTS = {
        { "default", null },
        { "visionos", "youtube:player_client=visionos" },
        { "tv", "youtube:player_client=tv" },
        { "tv_downgraded", "youtube:player_client=tv_downgraded" },
        { "web_safari", "youtube:player_client=web_safari" }
    };

    /**
     * Проверка ссылки: столько ждём ответа раздачи. Дольше нет смысла — впереди
     * ещё ступени перебора, а тишина в плеере тем временем идёт.
     */
    private static final int PROBE_TIMEOUT_MS = 8000;

    /** Заявка на разбор. Ждёт своей полосы или уже едет по ней. */
    private static final class Job {
        final String videoId;
        /**
         * Ссылка, которую плеер уже попробовал и играть не смог: такая дорожка
         * при выборе пропускается.
         *
         * Много от этого ждать не стоит — тот же клиент на повторный запрос
         * выдаёт новый подписанный адрес, и совпадение выходит нечасто.
         * Настоящая защита от нерабочих ссылок — проверка запросом ниже; это
         * дешёвая добавка к ней.
         */
        final String rejectUrl;
        final PluginCall call;

        Job(String videoId, String rejectUrl, PluginCall call) {
            this.videoId = videoId;
            this.rejectUrl = rejectUrl;
            this.call = call;
        }
    }

    /** Полоса человека: сюда попадает то, чего кто-то ждёт прямо сейчас. */
    private final BlockingQueue<Job> urgentLane = new LinkedBlockingQueue<>();

    /** Полоса фона: прогрев следующих треков очереди. */
    private final BlockingQueue<Job> backgroundLane = new LinkedBlockingQueue<>();

    /**
     * Заявки, которые ещё ждут очереди. Нужны ради {@link #raisePriority}:
     * человек может нажать play ровно на том, что греется в фоне, и тогда
     * заявку надо перенести, а не ставить вторую.
     */
    private final Map<String, Job> waiting = new HashMap<>();

    /** Свой замок для очередей: {@link #ensureReady} держит свой секундами. */
    private final Object lock = new Object();

    /** Проверка готовности и обновление — не разбор, и полосы занимать не должны. */
    private final ExecutorService utility = Executors.newSingleThreadExecutor();

    private Thread urgentWorker;
    private Thread backgroundWorker;

    /**
     * Итог распаковки Python и yt-dlp. `null` — ещё не пробовали.
     *
     * Распаковка идёт секунды и только при первом запуске после установки,
     * поэтому она отложена до первого разбора: держать её в `load()` значило бы
     * задерживать появление окна ради того, чем человек, может быть, сегодня и
     * не воспользуется.
     */
    private Boolean ready;

    @Override
    public void load() {
        super.load();
        urgentWorker = startWorker("wireon-ytdlp-urgent", urgentLane);
        backgroundWorker = startWorker("wireon-ytdlp-background", backgroundLane);
    }

    @Override
    protected void handleOnDestroy() {
        if (urgentWorker != null) urgentWorker.interrupt();
        if (backgroundWorker != null) backgroundWorker.interrupt();
        utility.shutdownNow();
        super.handleOnDestroy();
    }

    private Thread startWorker(String name, final BlockingQueue<Job> lane) {
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                while (!Thread.currentThread().isInterrupted()) {
                    Job job;
                    try {
                        job = lane.take();
                    } catch (InterruptedException stop) {
                        return;
                    }
                    synchronized (lock) {
                        if (waiting.get(job.videoId) == job) waiting.remove(job.videoId);
                    }
                    serve(job);
                }
            }
        }, name);
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    /**
     * Готов ли разбор на устройстве.
     *
     * Нужен веб-части, чтобы не ждать распаковки на пустом месте: в сборке для
     * браузера и в старых APK плагина нет вовсе, и лестница обязана это
     * различать заранее, а не по отказу первого трека.
     */
    @PluginMethod
    public void available(final PluginCall call) {
        utility.execute(new Runnable() {
            @Override
            public void run() {
                JSObject result = new JSObject();
                result.put("available", ensureReady());
                call.resolve(result);
            }
        });
    }

    /**
     * Прямая ссылка на аудиодорожку.
     *
     * Возвращает ту же форму, что главный процесс на десктопе и наш сервер, —
     * `streamUrl`, `format`, `bitrate`, `expiresAt`. Совпадение формы и есть
     * причина, по которой ни плеер, ни разбор ошибок трогать не пришлось.
     */
    @PluginMethod
    public void resolve(PluginCall call) {
        final String videoId = call.getString("videoId");
        if (videoId == null || videoId.trim().isEmpty()) {
            call.reject("YT_BAD_ID: пустой идентификатор видео");
            return;
        }

        Job job = new Job(videoId.trim(), call.getString("rejectUrl"), call);
        boolean urgent = !"prefetch".equals(call.getString("priority"));

        synchronized (lock) {
            waiting.put(job.videoId, job);
            (urgent ? urgentLane : backgroundLane).add(job);
        }
    }

    /**
     * Переносит уже поставленную заявку в полосу человека.
     *
     * Нужно из-за склейки одинаковых запросов в веб-части: если ссылку уже
     * греет фон, второй вызов сюда не доходит вовсе — а значит и заявка так и
     * осталась бы фоновой, за спиной у остальных прогревов.
     */
    @PluginMethod
    public void raisePriority(PluginCall call) {
        String videoId = call.getString("videoId");
        boolean moved = false;
        synchronized (lock) {
            Job job = videoId == null ? null : waiting.get(videoId.trim());
            if (job != null && backgroundLane.remove(job)) {
                urgentLane.add(job);
                moved = true;
            }
        }
        JSObject result = new JSObject();
        result.put("moved", moved);
        call.resolve(result);
    }

    /**
     * Обновление самого yt-dlp.
     *
     * Единственная часть приложения, которая обязана уметь чиниться без нашего
     * участия: YouTube ломает разбор раз в несколько месяцев, а yt-dlp чинит
     * это за дни.
     *
     * Канал — ночной, тот же, что у настольной сборки. Стабильные сборки
     * yt-dlp выходят раз в месяц, а починки YouTube попадают в ночные в тот же
     * день; на стабильном канале телефон отставал от компьютера на недели
     * ровно в том, ради чего это обновление и делается.
     */
    @PluginMethod
    public void update(final PluginCall call) {
        utility.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel._NIGHTLY);
                    JSObject result = new JSObject();
                    result.put("version", YoutubeDL.getInstance().versionName(getContext()));
                    call.resolve(result);
                } catch (Throwable error) {
                    call.reject(describe(error));
                }
            }
        });
    }

    /** Распаковывает Python и yt-dlp один раз за запуск. Второй попытки нет. */
    private synchronized boolean ensureReady() {
        if (ready != null) return ready;
        try {
            YoutubeDL.getInstance().init(getContext());
            ready = Boolean.TRUE;
        } catch (Throwable error) {
            Log.e(TAG, "yt-dlp не поднялся: " + error.getMessage(), error);
            ready = Boolean.FALSE;
        }
        return ready;
    }

    private void serve(Job job) {
        try {
            if (!ensureReady()) {
                job.call.reject("YT_BINARY_MISSING: yt-dlp не распаковался на этом устройстве");
                return;
            }
            job.call.resolve(resolveBlocking(job));
        } catch (Throwable error) {
            job.call.reject(describe(error));
        }
    }

    /**
     * Перебор ступеней до первой ссылки, которая действительно открывается.
     *
     * Отказ, одинаковый для любого клиента (видео удалено, приватное, эфир),
     * обрывает перебор: ещё четыре попытки — это полминуты ожидания ради того
     * же ответа.
     */
    private JSObject resolveBlocking(Job job) throws Throwable {
        List<String> failures = new ArrayList<>();
        long startedAt = System.currentTimeMillis();
        boolean sawBotCheck = false;

        for (String[] attempt : ATTEMPTS) {
            String label = attempt[0];
            try {
                VideoInfo info = fetchInfo(job.videoId, attempt[1]);
                Choice picked = pickAudioFormat(info, job.rejectUrl);
                if (picked == null) {
                    failures.add(label + ": пригодного аудио в ответе нет");
                    continue;
                }

                // Манифест байтовым диапазоном не проверить, а hls.js сам скажет
                // о своей беде — такая ссылка идёт без проверки.
                if (!picked.manifest) {
                    int status = probe(picked.url);
                    if (status != 200 && status != 206) {
                        failures.add(label + ": ссылка отклонена при проверке (" + status + ")");
                        Log.w(TAG, "ступень " + label + " для " + job.videoId
                            + ": ссылка не открылась (" + status + ")");
                        continue;
                    }
                }

                JSObject result = new JSObject();
                result.put("streamUrl", picked.url);
                result.put("format", picked.manifest ? "hls" : picked.ext);
                result.put("bitrate", picked.bitrate);
                result.put("expiresAt", expiryOf(picked.url));
                Log.i(TAG, job.videoId + " разобран ступенью " + label + " за "
                    + (System.currentTimeMillis() - startedAt) + " мс"
                    + (failures.isEmpty() ? "" : " (неудачных ступеней: " + failures.size() + ")"));
                return result;
            } catch (Throwable error) {
                String message = error.getMessage() == null ? "" : error.getMessage();
                failures.add(label + ": " + message);

                if (isBotCheck(message)) sawBotCheck = true;

                // Возраст, регион, удалённое видео — одинаковы для всех клиентов.
                // Продолжать перебор незачем, а точный ответ человеку полезнее,
                // чем «ничего не вышло».
                String terminal = terminalCode(message);
                if (terminal != null) throw new IllegalStateException(terminal + ": " + message);
            }
        }

        String detail = joined(failures);
        if (sawBotCheck) {
            throw new IllegalStateException(
                "YT_BOT_CHECK: YouTube просит подтвердить, что вы не робот; " + detail);
        }
        throw new IllegalStateException("YT_ALL_ATTEMPTS_FAILED: " + detail);
    }

    private VideoInfo fetchInfo(String videoId, String extractorArgs) throws Throwable {
        YoutubeDLRequest request = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + videoId);
        /*
         * Формат не задаётся нарочно.
         *
         * Пока стоял `-f bestaudio[ext=m4a]/bestaudio/best`, часть клиентов
         * отвечала «Requested format is not available» и выбывала целиком — в
         * том числе `web_safari`, у которого прогрессивных форматов нет вовсе,
         * только HLS. Выбор делается ниже, по всему списку сразу: так видно и
         * запасные варианты, и то, манифест это или нет.
         */
        request.addOption("--no-playlist");
        // Мобильная сеть отваливается чаще домашней, а ждать полминуты молча
        // хуже, чем перейти к следующей ступени.
        request.addOption("--socket-timeout", "12");
        request.addOption("--retries", "1");
        request.addOption("--no-check-certificates");
        if (extractorArgs != null) request.addOption("--extractor-args", extractorArgs);
        return YoutubeDL.getInstance().getInfo(request);
    }

    /** Выбранная дорожка вместе с тем, что о ней надо знать плееру. */
    private static final class Choice {
        String url;
        String ext = "m4a";
        int bitrate;
        boolean manifest;
    }

    /**
     * Лучшая играбельная дорожка из ответа yt-dlp.
     *
     * Прогрессивный HTTP выигрывает у манифеста: первый `<audio>` играет сам,
     * второму нужен hls.js. Дорожка без картинки — у дорожки с картинкой:
     * играют обе, но вторая тратит мобильный трафик на кадры, которых никто не
     * видит. `m4a` — у `webm`: его понимает WebView любой версии.
     */
    private Choice pickAudioFormat(VideoInfo info, String rejectUrl) {
        if (info == null) return null;

        List<VideoFormat> candidates = new ArrayList<>();
        if (info.getFormats() != null) candidates.addAll(info.getFormats());

        Choice best = null;
        int bestScore = Integer.MIN_VALUE;
        for (VideoFormat format : candidates) {
            String url = format.getUrl();
            if (url == null || url.isEmpty()) continue;
            if (rejectUrl != null && rejectUrl.equals(url)) continue;

            boolean audioOnly = "none".equals(format.getVcodec());
            String acodec = format.getAcodec();
            boolean hasAudio = acodec != null && !"none".equals(acodec);
            if (!audioOnly && !hasAudio) continue;

            boolean manifest = looksLikeManifest(url);
            String ext = format.getExt() == null ? "" : format.getExt();
            int rate = format.getAbr() > 0 ? format.getAbr() : format.getTbr();
            int score = (audioOnly ? 4000 : 500)
                + (manifest ? 0 : 2000)
                + ("m4a".equals(ext) ? 200 : "webm".equals(ext) ? 100 : 0)
                + Math.min(Math.max(rate, 0), 320);

            if (score > bestScore) {
                bestScore = score;
                best = new Choice();
                best.url = url;
                best.ext = ext.isEmpty() ? "m4a" : ext;
                best.bitrate = Math.max(rate, 0);
                best.manifest = manifest;
            }
        }

        if (best != null) return best;

        // Ответ без списка форматов: у некоторых клиентов ссылка лежит прямо в
        // корне. Хуже, чем выбор, но лучше, чем отказ.
        String direct = info.getUrl();
        if (direct == null || direct.isEmpty()) return null;
        if (rejectUrl != null && rejectUrl.equals(direct)) return null;
        Choice fallback = new Choice();
        fallback.url = direct;
        fallback.ext = info.getExt() == null ? "m4a" : info.getExt();
        fallback.manifest = looksLikeManifest(direct);
        return fallback;
    }

    private boolean looksLikeManifest(String url) {
        String lower = url.toLowerCase(Locale.ROOT);
        return lower.contains(".m3u8") || lower.contains("/manifest/");
    }

    /**
     * Открывается ли ссылка отсюда — тем же запросом, что сделает плеер.
     *
     * Диапазон именно открытый (`bytes=0-`). На ограниченный (`bytes=0-1`)
     * перекрытая ссылка отвечает 206, и проверка пропускала бы ровно те ссылки,
     * ради которых она и нужна: Chromium просит файл целиком, и *на это*
     * приходит 403.
     *
     * @return код ответа, или -1, если до раздачи не достучались
     */
    private int probe(String streamUrl) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(streamUrl).openConnection();
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Range", "bytes=0-");
            connection.setConnectTimeout(PROBE_TIMEOUT_MS);
            connection.setReadTimeout(PROBE_TIMEOUT_MS);
            return connection.getResponseCode();
        } catch (IOException | RuntimeException error) {
            return -1;
        } finally {
            // Тело нам не нужно: как только известен код, держать сокет открытым
            // значит качать трек, который мы, может быть, сейчас же выбросим.
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Когда ссылка перестанет работать.
     *
     * YouTube пишет срок прямо в адрес параметром `expire` — в секундах эпохи.
     * Своя догадка «час от сейчас» разошлась бы с настоящим сроком, и
     * разошлась бы в худшую сторону: сохранённая в очередь ссылка отдавала бы
     * 403 в тот момент, когда до трека дойдёт очередь.
     */
    private long expiryOf(String url) {
        try {
            int at = url.indexOf("expire=");
            if (at < 0) return 0L;
            int from = at + "expire=".length();
            int to = from;
            while (to < url.length() && Character.isDigit(url.charAt(to))) to++;
            if (to == from) return 0L;
            return Long.parseLong(url.substring(from, to)) * 1000L;
        } catch (Throwable ignored) {
            return 0L;
        }
    }

    private String joined(List<String> parts) {
        StringBuilder out = new StringBuilder();
        for (String part : parts) {
            if (out.length() > 0) out.append("; ");
            out.append(part);
        }
        return out.length() == 0 ? "yt-dlp не отдал ссылку" : out.toString();
    }

    /**
     * «Sign in to confirm you are not a bot».
     *
     * Это не приговор конкретному видео: один клиент получает проверку, другой
     * в ту же секунду отдаёт формат, — поэтому перебор она не обрывает. Но если
     * её увидели все ступени, честный ответ человеку не «ничего не вышло», а
     * «YouTube требует подтверждения».
     */
    private boolean isBotCheck(String message) {
        String lower = message.toLowerCase(Locale.ROOT);
        return lower.contains("not a bot") || lower.contains("bot check")
            || lower.contains("confirm your identity");
    }

    /** Код отказа, одинакового для любого клиента, или null — тогда перебор идёт дальше. */
    private String terminalCode(String message) {
        String lower = message.toLowerCase(Locale.ROOT);
        if (message.startsWith("YT_")) return message.split(":", 2)[0];
        if (lower.contains("age-restricted") || lower.contains("confirm your age")
            || lower.contains("inappropriate for some users")) return "YT_AGE_RESTRICTED";
        if (lower.contains("private video") || lower.contains("granted access")) return "YT_PRIVATE";
        if (lower.contains("available in your country") || lower.contains("available in your location")
            || lower.contains("geo restricted") || lower.contains("geo-restricted")
            || lower.contains("blocked it in your country")) return "YT_GEO_BLOCKED";
        if (lower.contains("video unavailable") || lower.contains("has been removed")
            || lower.contains("been terminated") || lower.contains("does not exist")) return "YT_UNAVAILABLE";
        if (lower.contains("is live") || lower.contains("premiere")
            || lower.contains("live event will begin")) return "YT_LIVE";
        return null;
    }

    /**
     * Отказ в виде `КОД: подробности`.
     *
     * Форма не произвольная: `describePlaybackError` в веб-части ищет коды
     * `YT_*` именно так, и совпадение формата — причина, по которой человек
     * увидит «Это приватное видео», а не «что-то пошло не так». Тот же приём,
     * что у моста к серверу.
     */
    private String describe(Throwable error) {
        String message = error == null || error.getMessage() == null ? "" : error.getMessage();
        String lower = message.toLowerCase(Locale.ROOT);

        if (message.startsWith("YT_")) return message;
        if (isBotCheck(message)) return "YT_BOT_CHECK: YouTube просит подтвердить, что вы не робот";

        String terminal = terminalCode(message);
        if (terminal != null) return terminal + ": " + message;

        if (lower.contains("unable to download") || lower.contains("timed out")
                || lower.contains("connection") || lower.contains("resolve host")) {
            return "YT_NETWORK: нет связи с YouTube";
        }
        Log.w(TAG, "неразобранный отказ yt-dlp: " + message);
        return "YT_ALL_ATTEMPTS_FAILED: " + (message.isEmpty() ? "yt-dlp не отдал ссылку" : message);
    }
}
