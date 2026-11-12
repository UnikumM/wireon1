package pro.wireon.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

/**
 * Служба, которая держит приложение живым, пока играет звук.
 *
 * Зачем она нужна. Звук в Wireon играет обычный элемент `<audio>` внутри
 * WebView. Пока приложение на экране, Android его не трогает; стоит свернуть —
 * и система вправе усыпить процесс, потому что для неё это просто окно, а не
 * плеер. Слышно это как обрыв трека через минуту-другую после сворачивания.
 *
 * Служба на переднем плане — единственный способ сказать системе «здесь идёт
 * воспроизведение». Сама она ничего не проигрывает: звук по-прежнему в WebView,
 * а служба только держит процесс и показывает уведомление с кнопками.
 *
 * Всё внутри обёрнуто в try/catch намеренно. Отказ службы обязан остаться
 * отказом фонового режима: музыка продолжит играть, пока приложение на экране,
 * — а вот падение при старте убило бы приложение целиком.
 */
public class PlaybackService extends Service {

    private static final String TAG = "WireonPlayback";
    private static final String CHANNEL_ID = "wireon_playback";
    private static final int NOTIFICATION_ID = 4210;

    public static final String ACTION_START = "pro.wireon.music.START";
    public static final String ACTION_STOP = "pro.wireon.music.STOP";
    public static final String ACTION_UPDATE = "pro.wireon.music.UPDATE";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_ARTWORK = "artwork";

    /**
     * Обложка на весь пульт занимает столько. Больше грузить незачем: шторка
     * всё равно ужмёт, а память на 500 МБ у телефона общая с приложением.
     */
    private static final int ARTWORK_MAX_PX = 512;

    /** Куда служба сообщает о нажатиях на кнопки уведомления. */
    public interface CommandListener {
        void onCommand(String command);
    }

    private static CommandListener listener;

    public static void setCommandListener(CommandListener next) {
        listener = next;
    }

    /** Работающая служба — чтобы позицию можно было передать без нового intent. */
    private static PlaybackService running;

    /*
     * Что известно о позиции. Статические, потому что позиция может прийти
     * раньше, чем служба поднялась: тогда она применит их при запуске.
     * Длительность не больше нуля — «неизвестна»: полосы в шторке тогда нет.
     */
    private static long durationMs = -1L;
    private static long positionMs = 0L;
    private static float rate = 1f;
    private static long positionAt = 0L;

    /**
     * Длительность и позиция от плеера. До 4.0.2 сюда не приходило ничего:
     * сессия сообщала «позиция неизвестна», длительности не называла вовсе, и
     * полоса в уведомлении стояла на «00:00 / 00:00».
     */
    public static void updatePosition(long nextDurationMs, long nextPositionMs, float nextRate, boolean nowPlaying) {
        durationMs = nextDurationMs > 0 ? nextDurationMs : -1L;
        positionMs = Math.max(0L, durationMs > 0 ? Math.min(nextPositionMs, durationMs) : nextPositionMs);
        rate = nextRate > 0f ? nextRate : 1f;
        positionAt = android.os.SystemClock.elapsedRealtime();

        PlaybackService current = running;
        if (current == null) return;
        current.playing = nowPlaying;
        current.updateSessionMetadata();
        current.updateSessionState();
    }

    private MediaSessionCompat session;
    private String title = "Wireon";
    private String artist = "";
    private boolean playing = true;

    /**
     * Обложка и адрес, с которого она взята.
     *
     * Держим пару, а не только картинку, чтобы не качать одно и то же на каждую
     * паузу: уведомление перерисовывается на любое изменение состояния, а
     * обложка при этом меняется только со сменой трека.
     */
    private String artworkUrl = "";
    private Bitmap artwork;
    private java.util.concurrent.ExecutorService loader;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            createChannel();
            session = new MediaSessionCompat(this, "WireonSession");
            session.setCallback(new MediaSessionCompat.Callback() {
                @Override
                public void onPlay() {
                    dispatch("play");
                }

                @Override
                public void onPause() {
                    dispatch("pause");
                }

                @Override
                public void onSkipToNext() {
                    dispatch("next");
                }

                @Override
                public void onSkipToPrevious() {
                    dispatch("prev");
                }

                @Override
                public void onStop() {
                    dispatch("pause");
                }

                @Override
                public void onSeekTo(long position) {
                    // Перемотка полосой в шторке. Решает по-прежнему плеер в
                    // WebView: сюда новая позиция вернётся его же сообщением.
                    dispatch("seek:" + Math.max(0L, position));
                }
            });
            session.setActive(true);
            running = this;
        } catch (Throwable error) {
            // Без сессии останутся кнопки уведомления, но не блокировка экрана.
            Log.w(TAG, "не удалось поднять медиасессию: " + error.getMessage());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            String action = intent == null ? ACTION_START : intent.getAction();

            if (ACTION_STOP.equals(action)) {
                stopSelf();
                return START_NOT_STICKY;
            }

            if (intent != null) {
                if (intent.hasExtra(EXTRA_TITLE)) title = String.valueOf(intent.getStringExtra(EXTRA_TITLE));
                if (intent.hasExtra(EXTRA_ARTIST)) artist = String.valueOf(intent.getStringExtra(EXTRA_ARTIST));
                if (intent.hasExtra(EXTRA_PLAYING)) playing = intent.getBooleanExtra(EXTRA_PLAYING, true);
                if (intent.hasExtra(EXTRA_ARTWORK)) {
                    requestArtwork(String.valueOf(intent.getStringExtra(EXTRA_ARTWORK)));
                }
            }

            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // С Android 14 тип службы обязателен, иначе система её убивает
                // сразу же с исключением о недостающем типе.
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            updateSessionMetadata();
            updateSessionState();
        } catch (Throwable error) {
            Log.w(TAG, "фоновый режим не поднялся: " + error.getMessage());
            stopSelf();
        }
        // `START_NOT_STICKY`: воскрешать службу без приложения бессмысленно —
        // звук живёт в WebView, которого после смерти процесса уже нет.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        try {
            if (loader != null) {
                loader.shutdownNow();
                loader = null;
            }
        } catch (Throwable ignored) {
            // Остановка загрузчика обложек не должна мешать остановке службы.
        }
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        } catch (Throwable ignored) {
            // Освобождение сессии не должно мешать остановке.
        }
        super.onDestroy();
    }

    /**
     * Тянет обложку и перерисовывает уведомление, когда она пришла.
     *
     * В отдельном потоке, потому что `onStartCommand` идёт по главному, а сеть
     * на главном потоке в Android — это исключение, а не медленный вызов.
     * Уведомление при этом показывается сразу и без картинки: пульт без
     * обложки лучше, чем пульт, появившийся через секунду.
     */
    private void requestArtwork(String url) {
        if (url == null || url.isEmpty() || url.equals(artworkUrl)) return;
        artworkUrl = url;
        artwork = null;

        if (loader == null) loader = java.util.concurrent.Executors.newSingleThreadExecutor();
        loader.execute(() -> {
            Bitmap loaded = fetchBitmap(url);
            if (loaded == null || !url.equals(artworkUrl)) return;
            artwork = loaded;
            updateSessionMetadata();
            try {
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification());
            } catch (Throwable error) {
                Log.w(TAG, "обложка не доехала до уведомления: " + error.getMessage());
            }
        });
    }

    private Bitmap fetchBitmap(String url) {
        java.net.HttpURLConnection connection = null;
        try {
            connection = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            try (java.io.InputStream stream = connection.getInputStream()) {
                Bitmap raw = android.graphics.BitmapFactory.decodeStream(stream);
                if (raw == null) return null;
                int side = Math.max(raw.getWidth(), raw.getHeight());
                if (side <= ARTWORK_MAX_PX) return raw;
                float scale = (float) ARTWORK_MAX_PX / side;
                return Bitmap.createScaledBitmap(
                    raw,
                    Math.round(raw.getWidth() * scale),
                    Math.round(raw.getHeight() * scale),
                    true
                );
            }
        } catch (Throwable error) {
            // Обложка — украшение пульта. Её отсутствие не должно ничего ломать.
            Log.w(TAG, "обложку не забрали: " + error.getMessage());
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void dispatch(String command) {
        CommandListener current = listener;
        if (current != null) current.onCommand(command);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Воспроизведение",
            // `LOW`: уведомление плеера — это пульт, а не новость. На обычной
            // важности каждый трек сопровождался бы звуком и всплывашкой.
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Управление воспроизведением, пока приложение свёрнуто");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent openIntent = PendingIntent.getActivity(this, 0, open, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(artist)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openIntent)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setLargeIcon(artwork)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        builder.addAction(action("prev", android.R.drawable.ic_media_previous, "Назад"));
        builder.addAction(
            playing
                ? action("pause", android.R.drawable.ic_media_pause, "Пауза")
                : action("play", android.R.drawable.ic_media_play, "Играть")
        );
        builder.addAction(action("next", android.R.drawable.ic_media_next, "Дальше"));

        try {
            MediaStyle style = new MediaStyle().setShowActionsInCompactView(0, 1, 2);
            if (session != null) style.setMediaSession(session.getSessionToken());
            builder.setStyle(style);
        } catch (Throwable error) {
            // Без MediaStyle уведомление останется обычным, с теми же кнопками.
            Log.w(TAG, "MediaStyle недоступен: " + error.getMessage());
        }

        return builder.build();
    }

    private NotificationCompat.Action action(String command, int icon, String label) {
        Intent intent = new Intent(this, PlaybackReceiver.class).setAction(command);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pending = PendingIntent.getBroadcast(this, command.hashCode(), intent, flags);
        return new NotificationCompat.Action(icon, label, pending);
    }

    /**
     * Название, исполнитель, обложка и длительность — в саму сессию.
     *
     * Полосу в шторке система строит по длительности из сведений сессии, а не
     * из уведомления. Неизвестная длительность передаётся как -1: так полоса
     * скрыта, а не показывает «00:00».
     */
    private void updateSessionMetadata() {
        if (session == null) return;
        try {
            MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs > 0 ? durationMs : -1L);
            if (artwork != null) metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
            session.setMetadata(metadata.build());
        } catch (Throwable error) {
            Log.w(TAG, "сведения сессии не обновлены: " + error.getMessage());
        }
    }

    private void updateSessionState() {
        if (session == null) return;
        try {
            boolean known = durationMs > 0;
            long actions = PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
            // Перематывать можно только там, где известно, докуда.
            if (known) actions |= PlaybackStateCompat.ACTION_SEEK_TO;

            // Позицию система экстраполирует сама: от `positionMs` со скоростью
            // `rate`, считая с `positionAt`. На паузе скорость нулевая — полоса стоит.
            PlaybackStateCompat state = new PlaybackStateCompat.Builder()
                .setActions(actions)
                .setState(
                    playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                    known ? positionMs : PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    playing ? rate : 0f,
                    positionAt > 0L ? positionAt : android.os.SystemClock.elapsedRealtime()
                )
                .build();
            session.setPlaybackState(state);
        } catch (Throwable error) {
            Log.w(TAG, "состояние сессии не обновлено: " + error.getMessage());
        }
    }
}
