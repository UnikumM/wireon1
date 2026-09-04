import { create } from 'zustand';
import type { UpdateState } from '../types/electron';
import { APP_VERSION } from '../utils/appInfo';

/**
 * Состояние автообновления в рендерере.
 *
 * Считать здесь нечего: всё решает главный процесс, а это — его зеркало плюс
 * два флага самого интерфейса (идёт ли ручная проверка и закрыл ли человек
 * плашку). Ничего не опрашивается по таймеру: состояние приходит событием.
 */

function bridge(): Window['electronAPI'] | undefined {
  return typeof window !== 'undefined' ? window.electronAPI : undefined;
}

export interface UpdateStore extends UpdateState {
  /** Есть ли мост в главный процесс. В браузере обновлять нечего. */
  hasBridge: boolean;
  /** Нажали «Проверить сейчас» и ждём ответа. */
  isChecking: boolean;
  /** Плашку закрыли — до новой версии больше не показываем. */
  dismissed: boolean;
  /** Подписывается на события и спрашивает состояние. Возвращает отписку. */
  init: () => () => void;
  apply: (state: UpdateState) => void;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
  reset: () => void;
}

const INITIAL: UpdateState & { hasBridge: boolean; isChecking: boolean; dismissed: boolean } = {
  status: 'idle',
  // До первого ответа главного процесса показываем версию сборки рендерера —
  // она та же самая, просто зашита при сборке.
  currentVersion: APP_VERSION,
  newVersion: null,
  percent: 0,
  message: null,
  checkedAt: null,
  hasBridge: false,
  isChecking: false,
  dismissed: false
};

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  ...INITIAL,

  init: () => {
    const api = bridge();
    if (!api?.onUpdateState || !api.getUpdateState) {
      // Веб-сборка или старая сборка приложения: обновлять нечего, и говорить
      // об ошибке не о чем.
      set({ hasBridge: false, status: 'unsupported', message: null });
      return () => {
        // Подписки нет — отписываться не от чего.
      };
    }

    set({ hasBridge: true });
    const unsubscribe = api.onUpdateState((state) => {
      get().apply(state);
    });

    // Окно могло открыться уже после того, как обновление скачалось, — тогда
    // события не будет, и состояние нужно спросить самому.
    void api
      .getUpdateState()
      .then((state) => {
        if (state) get().apply(state);
      })
      .catch(() => {
        // Мост есть, но не ответил: оставляем как было, событие ещё придёт.
      });

    return unsubscribe;
  },

  apply: (state: UpdateState) => {
    const previous = get();
    // Новая версия — новая причина показать плашку, даже если прошлую закрыли.
    const versionChanged = previous.newVersion !== state.newVersion;
    // Готовый пакет — отдельный разговор. «Качаем 47%» закрывают именно потому,
    // что это не требует действий, и если тот же закрытый флаг проглотит потом
    // «перезапустите», человек не узнает главного и обновление зависнет до
    // случайного закрытия приложения.
    const becameReady = state.status === 'ready' && previous.status !== 'ready';
    const dismissed = previous.dismissed && !versionChanged && !becameReady;
    set({ ...state, dismissed });
  },

  check: async () => {
    const api = bridge();
    if (!api?.checkForUpdates) return;

    set({ isChecking: true });
    try {
      const state = await api.checkForUpdates();
      if (state) get().apply(state);
    } finally {
      set({ isChecking: false });
    }
  },

  install: async () => {
    const api = bridge();
    if (!api?.installUpdate) return;

    // Дальше приложение закрывается само, так что ответ приходит только когда
    // установка не запустилась.
    const started = await api.installUpdate();
    if (!started) {
      set({
        status: 'error',
        message:
          'Не удалось запустить установку. Закройте приложение и откройте снова — обновление поставится само.'
      });
    }
  },

  dismiss: () => {
    set({ dismissed: true });
  },

  reset: () => {
    set({ ...INITIAL });
  }
}));

export default useUpdateStore;
