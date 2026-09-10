package pro.wireon.music;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Обновление приложения на телефоне.
 *
 * На компьютере этим занимается electron-updater, а на Android ставить пакеты
 * умеет только сама система: скачать файл может кто угодно, но запустить
 * установку — только через отдельное разрешение и системное окно, где человек
 * подтверждает установку руками. Обойти это нельзя и не нужно: именно так
 * Android защищает людей от тихой подмены приложений.
 *
 * Отсюда разделение обязанностей. Скачивает файл JavaScript (ему проще
 * показывать проценты), а этот плагин делает две вещи, недоступные из WebView:
 * называет установленную версию и открывает системное окно установки.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String TAG = "AppUpdater";

    /** Тип, по которому система понимает, что перед ней приложение, а не файл. */
    private static final String APK_MIME = "application/vnd.android.package-archive";

    /**
     * Какая версия установлена сейчас.
     *
     * Спрашивается у системы, а не берётся из кода страницы: у телефонной сборки
     * своя линия номеров, и номер в интерфейсе с ней не совпадает.
     */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageManager packages = getContext().getPackageManager();
            PackageInfo info = packages.getPackageInfo(getContext().getPackageName(), 0);

            JSObject result = new JSObject();
            result.put("versionName", info.versionName);
            result.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode);
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException e) {
            call.reject("Не удалось узнать версию приложения", e);
        }
    }

    /** Разрешено ли приложению устанавливать пакеты. До Android 8 разрешение не требуется. */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", isInstallAllowed());
        call.resolve(result);
    }

    /**
     * Открывает системный экран, где человек разрешает установку из Wireon.
     *
     * Отдельным вызовом, а не внутри установки: разрешение спрашивают, когда
     * обновление уже скачано и человек нажал «установить», — просить его
     * заранее, ни за чем, значит пугать.
     */
    @PluginMethod
    public void requestInstallPermission(PluginCall call) {
        if (isInstallAllowed()) {
            call.resolve();
            return;
        }

        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось открыть настройки установки", e);
        }
    }

    /**
     * Отдаёт скачанный файл системе.
     *
     * Путь приходит из JavaScript, но наружу он не уходит: файл отдаётся через
     * `FileProvider` — временной ссылкой, действующей только для установщика.
     * Прямой `file://` начиная с Android 7 система не принимает вовсе.
     */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("Не указан файл обновления");
            return;
        }

        File apk = new File(path.replace("file://", ""));
        if (!apk.exists()) {
            call.reject("Файл обновления не найден: " + apk.getAbsolutePath());
            return;
        }

        if (!isInstallAllowed()) {
            call.reject("Установка запрещена: разрешите её в настройках системы");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );

            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Не удалось запустить установку", e);
            call.reject("Не удалось запустить установку", e);
        }
    }

    private boolean isInstallAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }
}
