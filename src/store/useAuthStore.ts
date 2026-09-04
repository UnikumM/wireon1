import { create } from 'zustand';
import { UserProfile } from '../types/music';
import {
  clearStoredSession,
  createGuestProfile,
  discordAuthService,
  getStoredSession,
  saveStoredSession
} from '../services/discordAuth';
import { cloudSyncEngine } from '../services/cloudSync';
import { NullRemoteAdapter } from '../services/cloudSync';
import { createWireonRemote, type WireonRemoteAdapter } from '../services/wireonRemote';
import {
  notifyLibraryChanged,
  startLibrarySignal,
  stopLibrarySignal
} from '../services/librarySignal';

/** Текст, который видит пользователь, когда сессия Discord перестала быть годной. */
export const SESSION_EXPIRED_MESSAGE =
  'Сессия Discord истекла. Войдите снова, чтобы восстановить связь.';

/**
 * Подключение удалённой стороны синхронизации.
 *
 * Здесь, а не в загрузочном эффекте приложения, потому что зависит она ровно от
 * входа: без подтверждённой личности серверу нечего сказать, чей это шкаф.
 * Токен читается функцией из самого стора, а не передаётся значением, — иначе
 * адаптер держал бы у себя копию, которая протухнет вместе с сессией и об этом
 * не узнает.
 */
/**
 * Как часто медиатека сама сверяется с сервером.
 *
 * Минута, а не полминуты по умолчанию: каждый заход — это полное слияние и
 * отправка медиатеки целиком, и на мобильной сети такое вдвое чаще заметно по
 * счёту за трафик, а не по удобству.
 */
const AUTO_SYNC_INTERVAL_MS = 60000;

/**
 * Столько между сверками там, где мгновенного звонка нет вовсе.
 *
 * На телефоне брокер недоступен принципиально: страница живёт на `https`, а
 * брокер у нас `ws://`, и Chromium запрещает такое соединение (см.
 * `librarySignal.wsBlockedHere`). Значит расписание там — единственный способ
 * узнать о чужих правках, и минута ожидания превращается в «не работает».
 * Тридцать секунд — компромисс: вдвое отзывчивее, а трафика всё ещё вдвое
 * меньше, чем у «раз в пятнадцать».
 */
const AUTO_SYNC_INTERVAL_NO_SIGNAL_MS = 30000;

/**
 * Ожидание изменений обычным запросом — там, где брокер недоступен.
 *
 * На телефоне слушать брокер нельзя вовсе: страница живёт на `https`, а брокер
 * отвечает по `ws://`, и браузер запрещает такое соединение сам. Обычные
 * запросы оттуда проходят, поэтому ожидание сделано обычным запросом: сервер
 * держит его открытым, пока сказать нечего, и отвечает сразу, как только есть.
 *
 * Почему не заменить этим брокер везде: брокер отвечает за 58 мс (замерено) и
 * не держит открытого соединения, а ожидание — держит и стоит одного
 * соединения на устройство. Там, где брокер работает, он лучше; здесь он
 * недоступен, и лучше ожидание, чем расписание.
 *
 * @returns функция остановки
 */
function startWaitLoop(remote: WireonRemoteAdapter): () => void {
  let alive = true;
  let revision = 0;
  let failures = 0;

  const loop = async (): Promise<void> => {
    while (alive) {
      try {
        const answer = await remote.waitForChange(revision);
        if (!alive) return;
        revision = answer.revision;
        failures = 0;
        if (answer.changed) syncOnNudge();
      } catch (err) {
        if (!alive) return;
        /*
         * Старый сервер такой ручки не знает, и это не ошибка, а обычное дело:
         * сборка у людей обновляется раньше сервера. Долбиться туда незачем —
         * уходим на расписание, как было до этой работы.
         *
         * Кодов два, и 405 здесь важнее 404: у нас зарегистрирован общий
         * маршрут `OPTIONS /{tail:.*}` под предзапросы, поэтому неизвестный
         * путь **находится**, а отвергается по методу. Проверено на живом
         * сервере до обновления — он ответил именно 405.
         */
        const failure = String(err instanceof Error ? err.message : err);
        if (failure.includes('HTTP_404') || failure.includes('HTTP_405')) {
          syncChannel = 'schedule';
          return;
        }
        /*
         * Отступ после отказа, и он обязателен.
         *
         * Без него оборванная сеть превращается в бесконечный цикл запросов на
         * полной скорости — телефон греется, трафик течёт, сервер получает
         * поток отказов. Растущая пауза до полуминуты делает из этого редкую
         * безобидную попытку.
         */
        failures += 1;
        const pause = Math.min(30000, 2000 * failures);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  };

  void loop();
  return () => {
    alive = false;
  };
}

/**
 * Чаще одного раза в столько секунд возвращение в приложение сверку не запускает.
 *
 * Переключение между окнами на ПК и уход-возврат на телефоне — события частые,
 * и без ограничителя каждое из них означало бы полное слияние и отправку
 * медиатеки целиком.
 */
const FOREGROUND_SYNC_COOLDOWN_MS = 10000;

/**
 * Через столько после последней местной правки медиатека уезжает на сервер.
 *
 * Не сразу: добавление десяти треков подряд — это десять изменений подряд, а
 * отправка каждый раз идёт медиатекой целиком. Пауза собирает их в одну
 * отправку. И не по общему расписанию: ждать до минуты там, где человек только
 * что нажал «в избранное», и есть то самое «синхронизация не работает».
 *
 * Полторы секунды, а не больше: вместе со звонком соседу (58 мс по замеру на
 * настоящем брокере) это и есть всё время от нажатия до появления на другом
 * устройстве. Пачку из десяти нажатий подряд полторы секунды всё ещё собирают
 * в одну отправку — быстрее человек не кликает.
 */
const LOCAL_PUSH_DELAY_MS = 1500;

/** Звонок приходит по делу, поэтому его ограничитель короче. */
const NUDGE_COOLDOWN_MS = 3000;

let lastForegroundSyncAt = 0;

/**
 * Идёт применение чужих правок.
 *
 * Пока флаг поднят, изменения медиатеки не считаются местными: иначе слияние
 * само себя запускало бы по кругу — приехало, записали, «медиатека изменилась»,
 * отправили, приехало снова.
 */
let applyingRemote = false;

/**
 * Каким способом это устройство узнаёт о чужих правках прямо сейчас.
 *
 * Нужно экрану настроек: до этого он показывал состояние брокера, а брокер —
 * лишь один из трёх способов. На телефоне он недоступен, и человек видел «нет
 * связи» там, где изменения на самом деле приходят за секунду.
 */
export type SyncChannel =
  /** Вход не выполнен или сервер не настроен — узнавать не от кого. */
  | 'none'
  /** Брокер: изменение долетает за десятки миллисекунд. */
  | 'instant'
  /** Ожидание обычным запросом: сервер отвечает, как только есть что сказать. */
  | 'waiting'
  /** Ни того, ни другого — остаётся расписание. */
  | 'schedule';

let syncChannel: SyncChannel = 'none';

/** Каким способом устройство узнаёт о чужих правках. Для экрана настроек. */
export function getSyncChannel(): SyncChannel {
  return syncChannel;
}
/** Снимает слушателей, заведённых {@link attachRemote}. */
let detachForeground: (() => void) | null = null;

function syncOnForeground(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  runSync(FOREGROUND_SYNC_COOLDOWN_MS);
}

/**
 * Сверка по звонку с другого устройства.
 *
 * Без проверки «видно ли окно» и с коротким ограничителем — в отличие от
 * возвращения в приложение. Разница по существу: возвращение — это догадка «а
 * вдруг что-то поменялось», а звонок — сообщение «поменялось точно». Ждать с
 * ним до следующего взгляда на экран значит вернуть ту самую минуту, ради
 * избавления от которой звонок и заведён.
 */
function syncOnNudge(): void {
  runSync(NUDGE_COOLDOWN_MS);
}

function runSync(cooldownMs: number): void {
  const now = Date.now();
  if (now - lastForegroundSyncAt < cooldownMs) return;
  lastForegroundSyncAt = now;
  void cloudSyncEngine.syncAll().catch(() => {
    // Отказ уже назван статусом движка.
  });
}

function attachRemote(): void {
  const remote = createWireonRemote(() => useAuthStore.getState().token);
  if (!remote) return;
  cloudSyncEngine.setRemoteAdapter(remote);

  detachForeground?.();

  /*
   * Экран перечитывается, когда с сервера приехало чужое.
   *
   * Здесь была вторая половина беды «синхронизация не работает». Первую —
   * самосверку, которая не заводилась, — починили ниже. Но и после неё
   * приехавшие плейлисты ложились в базу **молча**: `useLibraryStore` держит
   * свою копию, и до перезапуска приложения человек видел прежнее. То есть
   * добавленное на ПК появлялось на телефоне только после нажатия «Проверить»
   * и перезахода.
   */
  const stopWatching = cloudSyncEngine.onRemoteChange(() => {
    // Подгружается по требованию: медиатека уже импортирует этот стор ради
    // проверки «вошёл ли человек», и статический импорт обратно замкнул бы
    // круг на самом старте приложения.
    applyingRemote = true;
    void import('./useLibraryStore')
      .then(({ useLibraryStore }) => useLibraryStore.getState().loadInitialData())
      .finally(() => {
        applyingRemote = false;
      });
  });

  /*
   * Своя правка уезжает почти сразу, а не по общему расписанию.
   *
   * Сверка раз в минуту отправляет медиатеку заодно с приёмом, и от «нажал
   * сердечко на ПК» до «увидел на телефоне» набегало до двух минут: минута на
   * отправку и ещё минута на приём с другой стороны. Подписка ловит любую
   * правку — какой бы дорогой она ни пришла, — и ни одно место, где медиатека
   * меняется, для этого трогать не пришлось.
   */
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let stopLibraryWatch: (() => void) | null = null;
  void import('./useLibraryStore').then(({ useLibraryStore }) => {
    stopLibraryWatch = useLibraryStore.subscribe((state, previous) => {
      if (applyingRemote) return;
      if (state.favorites === previous.favorites && state.playlists === previous.playlists) return;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        pushTimer = null;
        lastForegroundSyncAt = Date.now();
        void cloudSyncEngine
          .syncAll()
          .then((result) => {
            // Звоним только после того, как изменения действительно уехали:
            // иначе сосед придёт за ними раньше, чем они там появятся.
            if (result.success && result.remoteConfigured) notifyLibraryChanged();
          })
          .catch(() => {
            // Отказ уже назван статусом движка.
          });
      }, LOCAL_PUSH_DELAY_MS);
    });
  });

  /*
   * Возвращение в приложение — тоже повод сверить.
   *
   * Самосверка идёт раз в минуту, и это верно для фона: реже — обидно, чаще —
   * трафик на пустом месте. Но смотрят на медиатеку ровно в ту секунду, когда
   * в приложение вернулись, и ждать там до минуты хуже всего. Ограничитель
   * выше не даёт этому превратиться в сверку на каждое переключение окна.
   */
  /*
   * Мгновенный звонок поверх сверки по расписанию.
   *
   * Расписание — раз в минуту, и для «поставил сердечко на компьютере — увидел
   * на телефоне» этого мало: минута читается как «не работает». Брокер, на
   * котором держится совместное прослушивание, умеет обратное — говорить
   * устройству, что пора сходить за данными. Через него не идёт ни байта
   * содержимого, только «сходи посмотри»; сами данные по-прежнему едут по
   * `/v1/sync`, где личность подтверждает Discord.
   *
   * Отказ здесь ничего не ломает: без звонка остаётся прежняя сверка.
   */
  const userId = cloudSyncEngine.getUserId();
  let stopWaitLoop: (() => void) | null = null;
  if (userId) {
    void startLibrarySignal({ userId, onNudge: syncOnNudge }).then((connected) => {
      if (connected) {
        syncChannel = 'instant';
        return;
      }
      // Брокера нет — ждём изменений обычным запросом. Расписание при этом
      // остаётся страховкой и учащается: если и ожидание не заладится, минута
      // молчания слишком долгая.
      cloudSyncEngine.startPeriodicSync(AUTO_SYNC_INTERVAL_NO_SIGNAL_MS);
      stopWaitLoop = startWaitLoop(remote);
      syncChannel = 'waiting';
    });
  }

  const onVisible = () => syncOnForeground();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisible);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onVisible);
  }
  detachForeground = () => {
    stopWatching();
    stopLibraryWatch?.();
    stopWaitLoop?.();
    stopLibrarySignal();
    if (pushTimer) clearTimeout(pushTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
    detachForeground = null;
  };

  /*
   * Заводить самосверку надо **здесь**, и это была отдельная поломка.
   *
   * `App.tsx` вызывает `startPeriodicSync` один раз при запуске — а в ту минуту
   * вход ещё не восстановлен, удалённой стороны нет, и `startPeriodicSync`
   * честно отказывается заводиться («no remote adapter is configured»). После
   * входа её никто не заводил заново, и самосверки не было ни разу: медиатека
   * уезжала на сервер только по нажатию «Проверить». Отсюда и «синхрон с
   * телефона не идёт на ПК» — он и не шёл, пока не нажмёшь.
   */
  cloudSyncEngine.startPeriodicSync(AUTO_SYNC_INTERVAL_MS);
  lastForegroundSyncAt = Date.now();
  // Первый заход сразу: ждать минуту после входа, чтобы увидеть свои плейлисты,
  // — это ровно то ожидание, ради которого человек и жал кнопку руками.
  void cloudSyncEngine.syncAll().catch(() => {
    // Отказ уже назван статусом движка; ронять вход из-за него незачем.
  });
}

/**
 * Отключение при выходе. Заглушка, а не «оставим как есть»: адаптер, у которого
 * больше нет токена, на каждом заходе ходил бы в сеть за отказом, а `syncAll`
 * показывал бы ошибку вместо честного «синхронизации нет».
 */
function detachRemote(): void {
  syncChannel = 'none';
  detachForeground?.();
  cloudSyncEngine.stopPeriodicSync();
  cloudSyncEngine.setRemoteAdapter(new NullRemoteAdapter());
}

/**
 * Canonical auth store shape. `discordAuth.ts` owns the `wireon_auth_*`
 * localStorage keys and the guest profile; this store never touches them
 * directly.
 */
export interface AuthStoreState {
  user: UserProfile | null;
  token: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  authStatus: 'idle' | 'authenticating' | 'authenticated' | 'guest' | 'error';
  error: string | null;
}

export interface AuthStoreActions {
  login: (user: UserProfile, token: string, expiresInSeconds?: number) => void;
  logout: () => void;
  setGuest: () => void;
  continueAsGuest: () => void;
  setSyncing: (isSyncing: boolean) => void;
  setLastSyncedAt: (timestamp: number) => void;
  setError: (error: string | null) => void;
  restoreSession: () => Promise<void>;
  /**
   * Проверяет, не истёк ли сохранённый токен. Возвращает true, если сессию
   * пришлось сбросить — вызывающая сторона тогда показывает сообщение.
   */
  checkSessionExpiry: () => boolean;
}

export type AuthStore = AuthStoreState & AuthStoreActions;

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isGuest: true,
  isSyncing: false,
  lastSyncedAt: null,
  authStatus: 'idle',
  error: null,

  login: (user: UserProfile, token: string, expiresInSeconds?: number) => {
    const storedProfile = saveStoredSession(user, token, expiresInSeconds);
    // Владелец локального журнала изменений живёт здесь, а не в компонентах:
    // иначе после перезапуска приложения он остаётся пустым.
    cloudSyncEngine.setUserId(storedProfile.id);

    /*
     * Состояние ставится **до** подключения удалённой стороны, и порядок здесь
     * не косметика.
     *
     * `WireonRemoteAdapter.isConfigured()` требует токен Discord, а берёт он
     * его из этого самого стора. Пока `set` шёл вторым, в момент
     * `attachRemote` токена ещё не было — и `startPeriodicSync` честно
     * отказывался заводиться со словами «сервер не настроен». Самосверка не
     * запускалась **ни разу**, ни при входе, ни при восстановлении сессии.
     * Работало только то, что вызывается вручную и позже: кнопка «Проверить» и
     * один заход сразу после входа. Снаружи это и выглядело как
     * «синхронизация работает хз когда — вроде только если перезайти и сменить
     * аккаунт».
     */
    set({
      user: storedProfile,
      token,
      isAuthenticated: true,
      isGuest: false,
      authStatus: 'authenticated',
      error: null
    });

    attachRemote();
  },

  logout: () => {
    clearStoredSession();
    cloudSyncEngine.setUserId(null);
    detachRemote();

    set({
      user: createGuestProfile(),
      token: null,
      isAuthenticated: false,
      isGuest: true,
      authStatus: 'guest',
      error: null
    });
  },

  setGuest: () => {
    cloudSyncEngine.setUserId(null);
    detachRemote();

    set({
      user: createGuestProfile(),
      token: null,
      isAuthenticated: false,
      isGuest: true,
      authStatus: 'guest',
      error: null
    });
  },

  continueAsGuest: () => {
    get().setGuest();
  },

  setSyncing: (isSyncing: boolean) => {
    set({ isSyncing });
  },

  setLastSyncedAt: (timestamp: number) => {
    set({ lastSyncedAt: timestamp });
  },

  setError: (error: string | null) => {
    set({
      error,
      authStatus: error ? 'error' : get().authStatus
    });
  },

  /**
   * Restores the persisted Discord session. An expired
   * `wireon_auth_token_expires` (or a token Discord no longer accepts) clears the
   * session and drops back to guest mode instead of resurrecting a stale user.
   */
  restoreSession: async () => {
    set({ authStatus: 'authenticating', error: null });

    const { user, token, isExpired } = getStoredSession();

    if (!user || !token) {
      get().setGuest();
      return;
    }

    if (isExpired) {
      clearStoredSession();
      get().setGuest();
      set({ error: SESSION_EXPIRED_MESSAGE });
      return;
    }

    try {
      const validated = await discordAuthService.validateSession();
      if (!validated) {
        get().setGuest();
        set({ error: 'Сессия Discord больше не действительна. Войдите снова, чтобы восстановить связь.' });
        return;
      }

      cloudSyncEngine.setUserId(validated.id);
      // Порядок тот же, что при входе, и по той же причине: удалённая сторона
      // считает себя настроенной только когда токен уже лежит в сторе.
      set({
        user: validated,
        token,
        isAuthenticated: true,
        isGuest: false,
        authStatus: 'authenticated',
        error: null
      });
      // Восстановление сессии — такой же вход, как через окно согласия. Без
      // этой строки синхронизация работала бы только до перезапуска: после него
      // человек вошедший, а удалённой стороны нет.
      attachRemote();
    } catch (err) {
      console.warn('[useAuthStore] Failed to validate the stored session:', err);
      get().setGuest();
    }
  },

  /**
   * Сессия проверяется не только на старте: приложение живёт неделями в трее, и
   * токен успевает истечь прямо во время работы. Тогда лучше честно уронить его
   * в гостя, чем оставить в шапке имя, за которым уже ничего нет.
   */
  checkSessionExpiry: () => {
    if (!get().isAuthenticated) return false;

    const { user, token, isExpired } = getStoredSession();
    if (user && token && !isExpired) return false;

    clearStoredSession();
    get().setGuest();
    set({ error: SESSION_EXPIRED_MESSAGE });
    return true;
  }
}));
