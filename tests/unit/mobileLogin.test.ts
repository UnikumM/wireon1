import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  DESKTOP_REDIRECT_URI,
  DiscordAuthService,
  getDefaultRedirectUri,
  isAuthCallbackUrl
} from '../../src/services/discordAuth';

/**
 * Вход через Discord на телефоне.
 *
 * До этого войти с Android было нельзя вовсе, и не из-за настроек: обёртка
 * попадала в ветку всплывающего окна, а та возвращается на `<origin>/auth/callback`.
 * origin в Capacitor — `https://localhost`, внутренний адрес приложения, до
 * которого системному браузеру не добраться физически. Ответ не приходил
 * никогда, и вход просто истекал по сроку.
 *
 * Поэтому проверяется здесь: выбор ветки, адрес возврата и то, что поток
 * переиспользован, а не написан заново, — плюс отказ, который иначе выглядит
 * зависанием на две минуты.
 */

/**
 * Плагинов Capacitor в прогоне нет: они есть в зависимостях, и без подмены
 * `loginWithCapacitor` собрал бы настоящий мост и завис бы в ожидании перехода,
 * которого в jsdom никогда не будет.
 */
vi.mock('../../src/services/capacitorAuthBridge', () => ({
  createCapacitorAuthBridge: async () => null
}));

const TOKEN = 'discord-access-token';

/**
 * Ответ Discord собирается из адреса, который открыло приложение.
 *
 * `state` придумывает сам поток входа и сверяет его на возврате — это защита от
 * подсунутого чужого ответа. Взять его можно только оттуда, куда его положили.
 */
function callbackFor(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state') ?? '';
  return `${DESKTOP_REDIRECT_URI}#access_token=${TOKEN}&token_type=Bearer&expires_in=604800&state=${state}`;
}

/** Мост той же формы, что у десктопа: поток входа общий. */
function fakeBridge() {
  const listeners: Array<(url: string) => void> = [];
  const cancels: Array<() => void> = [];
  return {
    listeners,
    cancels,
    opened: [] as string[],
    unsubscribed: 0,
    onDeepLink(callback: (url: string) => void) {
      listeners.push(callback);
      return () => {
        this.unsubscribed += 1;
      };
    },
    onCancelled(callback: () => void) {
      cancels.push(callback);
      return () => {};
    },
    async openExternal(url: string) {
      this.opened.push(url);
    }
  };
}

function pretendMobile(mobile: boolean) {
  const view = window as unknown as { Capacitor?: unknown; electronAPI?: unknown };
  if (mobile) {
    delete view.electronAPI;
    view.Capacitor = { isNativePlatform: () => true };
  } else {
    delete view.Capacitor;
  }
}

let service: DiscordAuthService;

beforeEach(() => {
  service = new DiscordAuthService();
});

afterEach(() => {
  const view = window as unknown as { Capacitor?: unknown };
  delete view.Capacitor;
  vi.restoreAllMocks();
});

describe('Адрес возврата на телефоне', () => {
  it('телефон возвращается схемой Discord, а не на адрес страницы', () => {
    // `https://localhost` — внутренний адрес приложения; системный браузер на
    // него не вернётся, а фрагмент с токеном по https на сервер не уходит вовсе.
    // Схема при этом не наша: Discord принимает только `discord-{ID заявки}`.
    pretendMobile(true);
    expect(getDefaultRedirectUri()).toMatch(/^discord-\d+:\/authorize\/callback$/);
  });

  it('в обычном браузере возврат по-прежнему на страницу', () => {
    pretendMobile(false);
    expect(getDefaultRedirectUri()).not.toBe(DESKTOP_REDIRECT_URI);
    expect(getDefaultRedirectUri()).toMatch(/\/auth\/callback$/);
  });

  it('адрес возврата один на обе платформы', () => {
    // В панели Discord один адрес, а не два, про которые надо помнить, какой чей.
    expect(isAuthCallbackUrl(DESKTOP_REDIRECT_URI)).toBe(true);
    expect(isAuthCallbackUrl(`${DESKTOP_REDIRECT_URI}#access_token=x`)).toBe(true);
  });
});

describe('Поток входа на телефоне', () => {
  it('открывает согласие и ждёт свою схему', async () => {
    const bridge = fakeBridge();
    const login = service.loginWithDeepLink({ clientId: '123', timeoutMs: 5000 }, bridge);

    await vi.waitFor(() => expect(bridge.opened).toHaveLength(1));
    expect(bridge.opened[0]).toContain('discord.com/api/oauth2/authorize');
    expect(bridge.opened[0]).toContain(encodeURIComponent(DESKTOP_REDIRECT_URI));

    // Профиль запрашивается у Discord — сеть в тесте подменена.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '42', username: 'Слушатель', avatar: null })
    } as unknown as Response);

    bridge.listeners[0](callbackFor(bridge.opened[0]));
    const session = await login;
    expect(session.token).toBe(TOKEN);
    expect(session.user.username).toBe('Слушатель');
  });

  it('чужой переход не считается ответом', async () => {
    // По схеме `wireon://` может прийти что угодно, не только вход.
    const bridge = fakeBridge();
    const login = service.loginWithDeepLink({ clientId: '123', timeoutMs: 200 }, bridge);
    await vi.waitFor(() => expect(bridge.opened).toHaveLength(1));

    bridge.listeners[0]('wireon://something/else');

    await expect(login).rejects.toThrow(/не завершён за/);
  });

  it('закрытое окно согласия — отказ сразу, а не ожидание срока', async () => {
    // Иначе приложение показывает «входим» две минуты, хотя закрывать уже нечего.
    const bridge = fakeBridge();
    const login = service.loginWithDeepLink({ clientId: '123', timeoutMs: 120000 }, bridge);
    await vi.waitFor(() => expect(bridge.cancels).toHaveLength(1));

    bridge.cancels[0]();

    await expect(login).rejects.toThrow(/Окно входа Discord закрыто/);
  });

  it('подписки снимаются, чтобы второй вход не поймал чужой ответ', async () => {
    const bridge = fakeBridge();
    const login = service.loginWithDeepLink({ clientId: '123', timeoutMs: 120000 }, bridge);
    await vi.waitFor(() => expect(bridge.cancels).toHaveLength(1));

    bridge.cancels[0]();
    await expect(login).rejects.toThrow();

    expect(bridge.unsubscribed).toBe(1);
  });

  it('без плагинов Capacitor говорит об этом, а не молчит', async () => {
    pretendMobile(true);
    await expect(service.loginWithCapacitor({ clientId: '123' })).rejects.toThrow(
      /плагинов Capacitor/
    );
  });
});
