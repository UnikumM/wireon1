/**
 * Транспорт входа через Discord на Android.
 *
 * Почему нужна третья ветка. На десктопе согласие открывается в окне, которым
 * владеет само приложение. В браузере — всплывающим окном, которое возвращается
 * на `<origin>/auth/callback` и передаёт токен открывшему. В обёртке Capacitor
 * не работает ни то, ни другое: `electronAPI` там нет, а origin страницы —
 * `https://localhost`, внутренний адрес приложения, на который системный
 * браузер вернуться не может физически.
 *
 * Работает единственный путь: открыть согласие снаружи и получить ответ своей
 * схемой `wireon://`. Это ровно то же, что делает `loginWithDeepLink` на
 * десктопе, поэтому и форма моста здесь та же — `onDeepLink` и `openExternal`.
 * Сам поток входа переиспользуется целиком, а не пишется заново.
 *
 * Токен приходит во фрагменте адреса (implicit grant). Своя схема отдаёт адрес
 * целиком, вместе с фрагментом, — из-за этого редирект и сделан на неё, а не на
 * `https`: фрагмент браузер на сервер не отправляет вовсе.
 *
 * Библиотеки подгружаются динамически: настольной и веб-сборке они не нужны, и
 * в их главный кусок попадать не должны.
 */

/** Ровно та поверхность, которую ждёт `loginWithDeepLink`. */
export interface DeepLinkAuthBridge {
  onDeepLink: (callback: (url: string) => void) => () => void;
  openExternal: (url: string) => void | Promise<void>;
  /**
   * Человек закрыл окно согласия сам.
   *
   * Без этого отказ от входа ничем не отличается от зависшего: приложение
   * ждало бы полные две минуты до срока, показывая «входим», хотя закрывать
   * окно уже некому.
   */
  onCancelled?: (callback: () => void) => () => void;
}

/**
 * Собирает мост поверх плагинов Capacitor, либо `null` — если их нет.
 *
 * `null` вместо исключения: отсутствие плагинов означает не поломку, а другую
 * платформу, и вызывающий выбирает следующий способ входа.
 */
export async function createCapacitorAuthBridge(): Promise<DeepLinkAuthBridge | null> {
  let App: any;
  let Browser: any;
  try {
    App = (await import('@capacitor/app')).App;
    Browser = (await import('@capacitor/browser')).Browser;
  } catch {
    return null;
  }
  if (!App?.addListener || !Browser?.open) return null;

  return {
    onDeepLink: (callback) => {
      // `addListener` отдаёт обещание дескриптора, а отписаться может
      // понадобиться раньше, чем оно разрешится: срок входа истекает сам по
      // себе. Поэтому флаг — иначе подписка переживёт отписку и второй вход
      // получит чужой ответ.
      let cancelled = false;
      let handle: any = null;

      void App.addListener('appUrlOpen', (event: { url?: string }) => {
        if (cancelled || !event?.url) return;
        // Окно согласия закрывается до разбора: иначе оно остаётся поверх
        // приложения, и человек видит пустую вкладку вместо своей медиатеки.
        void Browser.close?.().catch?.(() => {});
        callback(event.url);
      }).then((registered: any) => {
        handle = registered;
        if (cancelled) void handle?.remove?.();
      });

      return () => {
        cancelled = true;
        void handle?.remove?.();
      };
    },

    openExternal: async (url: string) => {
      await Browser.open({ url });
    },

    onCancelled: (callback) => {
      let cancelled = false;
      let handle: any = null;

      void Browser.addListener?.('browserFinished', () => {
        if (!cancelled) callback();
      })?.then?.((registered: any) => {
        handle = registered;
        if (cancelled) void handle?.remove?.();
      });

      return () => {
        cancelled = true;
        void handle?.remove?.();
      };
    }
  };
}
