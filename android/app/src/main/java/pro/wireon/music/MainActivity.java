package pro.wireon.music;

import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагин фонового режима регистрируется до `super`: Capacitor собирает
        // список плагинов при создании моста, и зарегистрированный позже в него
        // уже не попадёт.
        registerPlugin(BackgroundAudioPlugin.class);
        // yt-dlp на самом устройстве: домашний адрес вместо адреса дата-центра,
        // где YouTube требует доказать, что мы не робот.
        registerPlugin(YtDlpPlugin.class);
        super.onCreate(savedInstanceState);

        /*
         * Окно занимает весь экран, включая полосы системы.
         *
         * Без этого Android ужимал WebView до 712 px из 800: сверху оставалась
         * системная полоса своего цвета, а `env(safe-area-inset-top)` внутри
         * страницы был нулём — то есть интерфейс не знал ни про вырез, ни про
         * полосу жестов и не мог под них подстроиться. Теперь знает: отступы
         * даёт сам интерфейс через `--safe-top` и `--safe-bottom`.
         */
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }
}
