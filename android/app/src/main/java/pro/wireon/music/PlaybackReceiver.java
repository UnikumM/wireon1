package pro.wireon.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Кнопки уведомления.
 *
 * Отдельным приёмником, а не `PendingIntent` прямо в службу, потому что нажатие
 * должно доехать даже когда служба уже остановлена — иначе «Играть» на
 * поставленном на паузу треке не делает ничего и выглядит сломанной кнопкой.
 *
 * Приёмник ничего не решает сам: он передаёт название действия в JS, где живёт
 * настоящая очередь и состояние плеера. Дублировать эту логику здесь значило бы
 * завести второй плеер, который обязан согласовываться с первым.
 */
public class PlaybackReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        BackgroundAudioPlugin.deliver(intent.getAction());
    }
}
