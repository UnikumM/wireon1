package pro.wireon.music;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Мост между плеером в WebView и службой переднего плана.
 *
 * Разделение обязанностей строгое и намеренное: **звук остаётся в WebView**, а
 * нативная сторона только сообщает системе, что идёт воспроизведение, и рисует
 * уведомление. Второй плеер на нативной стороне пришлось бы согласовывать с
 * первым — с очередью, кроссфейдом, эквалайзером и «Моей волной», — и они
 * разошлись бы в первый же день.
 *
 * Ни один метод не бросает наружу. Отказ фонового режима обязан остаться
 * отказом фонового режима: музыка продолжит играть, пока приложение на экране.
 */
@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    private static final String TAG = "WireonPlayback";

    /** Живой экземпляр — чтобы приёмник уведомления знал, куда слать нажатия. */
    private static BackgroundAudioPlugin instance;

    @Override
    public void load() {
        instance = this;
        PlaybackService.setCommandListener(this::emitCommand);
    }

    @Override
    protected void handleOnDestroy() {
        PlaybackService.setCommandListener(null);
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    /** Нажатие на кнопку уведомления. Статически — приёмник живёт отдельно. */
    public static void deliver(String command) {
        BackgroundAudioPlugin current = instance;
        if (current != null) current.emitCommand(command);
    }

    private void emitCommand(String command) {
        try {
            JSObject payload = new JSObject();
            payload.put("command", command);
            notifyListeners("command", payload);
        } catch (Throwable error) {
            Log.w(TAG, "команда не доставлена: " + error.getMessage());
        }
    }

    /**
     * Спрашивает разрешение на уведомления, если его ещё нет.
     *
     * С Android 13 `POST_NOTIFICATIONS` — разрешение времени выполнения, и
     * одного объявления в манифесте мало: по умолчанию оно **запрещено**.
     * Проверено на эмуляторе 2026-08-28 — `dumpsys notification` показывал
     * `importance=NONE`, то есть уведомление службы не показывалось вовсе.
     * Снаружи это выглядит как «фоновый режим есть, а пульта нет».
     *
     * Спрашиваем при первом запуске звука, а не при старте приложения: так у
     * вопроса есть повод, и человек понимает, за что его просят.
     */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        try {
            Activity activity = getActivity();
            if (activity == null) return;
            if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
                return;
            }
            activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 4210);
        } catch (Throwable error) {
            // Отказ спросить — не повод не играть: служба поднимется и без
            // видимого уведомления, просто пульта не будет.
            Log.w(TAG, "не удалось запросить разрешение на уведомления: " + error.getMessage());
        }
    }

    /**
     * Включает фоновый режим и обновляет уведомление.
     *
     * Вызывается и на старте воспроизведения, и на смене трека: служба у нас
     * одна, а `startService` с новыми данными просто обновляет уведомление.
     */
    @PluginMethod
    public void start(PluginCall call) {
        try {
            ensureNotificationPermission();

            Intent intent = new Intent(getContext(), PlaybackService.class)
                .setAction(PlaybackService.ACTION_START)
                .putExtra(PlaybackService.EXTRA_TITLE, call.getString("title", "Wireon"))
                .putExtra(PlaybackService.EXTRA_ARTIST, call.getString("artist", ""))
                .putExtra(PlaybackService.EXTRA_PLAYING, Boolean.TRUE.equals(call.getBoolean("playing", true)))
                .putExtra(PlaybackService.EXTRA_ARTWORK, call.getString("artwork", ""));

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve(ok(true));
        } catch (Throwable error) {
            // Не `call.reject`: для вызывающего это не ошибка, а «фонового
            // режима не будет». Плеер продолжает работать как раньше.
            Log.w(TAG, "не удалось включить фоновый режим: " + error.getMessage());
            call.resolve(ok(false));
        }
    }

    /** Выключает фоновый режим: воспроизведение кончилось или его остановили. */
    @PluginMethod
    public void stop(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), PlaybackService.class).setAction(PlaybackService.ACTION_STOP);
            getContext().startService(intent);
            call.resolve(ok(true));
        } catch (Throwable error) {
            Log.w(TAG, "не удалось выключить фоновый режим: " + error.getMessage());
            call.resolve(ok(false));
        }
    }

    private JSObject ok(boolean value) {
        JSObject result = new JSObject();
        result.put("ok", value);
        return result;
    }
}
