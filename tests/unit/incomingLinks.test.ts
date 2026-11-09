import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  flushIncomingLinks,
  handleIncomingLink,
  isIncomingMusicLink,
  pendingIncomingLinks,
  resetIncomingLinks,
  startIncomingLinks
} from '../../src/services/incomingLinks';
import { useAuthStore } from '../../src/store/useAuthStore';
import { useUIStore } from '../../src/store/useUIStore';

/**
 * Ссылки на музыку, открытые в Wireon с телефона.
 *
 * Три вещи ломаются молча, и каждая проверяется: чужая ссылка, принятая за
 * свою (в поиск уедет возврат из Discord, и вход сломается); своя, не узнанная
 * (система предложила Wireon, человек выбрал — и ничего); и ссылка, пришедшая
 * до готовности приложения (экран поменяли, а `restoreSession` его вернул).
 */

/** Плагин Capacitor подменяется целиком: в jsdom его нативной стороны нет. */
const fakeApp = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: { url?: string }) => void>>();
  return {
    listeners,
    launchUrl: null as string | null,
    removed: 0,
    addListener(name: string, callback: (event: { url?: string }) => void) {
      const list = listeners.get(name) ?? [];
      list.push(callback);
      listeners.set(name, list);
      return Promise.resolve({
        remove: () => {
          this.removed += 1;
        }
      });
    },
    getLaunchUrl() {
      return Promise.resolve(this.launchUrl ? { url: this.launchUrl } : null);
    },
    emit(url: string) {
      for (const callback of listeners.get('appUrlOpen') ?? []) callback({ url });
    },
    reset() {
      listeners.clear();
      this.launchUrl = null;
      this.removed = 0;
    }
  };
});

vi.mock('@capacitor/app', () => ({ App: fakeApp }));

function pretendMobile(mobile: boolean) {
  const view = window as unknown as { Capacitor?: unknown; electronAPI?: unknown };
  if (mobile) {
    delete view.electronAPI;
    view.Capacitor = { isNativePlatform: () => true };
  } else {
    delete view.Capacitor;
  }
}

function ready() {
  useAuthStore.setState({ authStatus: 'guest' });
}

function notReady() {
  useAuthStore.setState({ authStatus: 'idle' });
}

function ui() {
  return useUIStore.getState();
}

const TRACK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

beforeEach(() => {
  resetIncomingLinks();
  fakeApp.reset();
  pretendMobile(false);
  ready();
  useUIStore.setState({
    activeView: 'home',
    searchQuery: '',
    isFullscreenPlayerOpen: true,
    isQueueOpen: true
  });
});

afterEach(() => {
  resetIncomingLinks();
  pretendMobile(false);
});

describe('incomingLinks: какие ссылки наши', () => {
  it('узнаёт все хосты из манифеста, включая короткие youtu.be и music.youtube.com', () => {
    const ours = [
      'https://youtube.com/watch?v=abc123xyz00',
      'https://www.youtube.com/watch?v=abc123xyz00&list=PL123456789012',
      'https://m.youtube.com/watch?v=abc123xyz00',
      'https://music.youtube.com/watch?v=abc123xyz00&si=share',
      'https://music.youtube.com/playlist?list=OLAK5uy_abcdef',
      'https://youtu.be/abc123xyz00?si=share',
      'https://soundcloud.com/artist/track-name',
      'https://m.soundcloud.com/artist/sets/album',
      'https://on.soundcloud.com/AbCdEf',
      // Регистр хоста и схема без шифрования — та же ссылка.
      'HTTPS://YouTu.be/abc123xyz00',
      'http://youtube.com/watch?v=abc123xyz00'
    ];
    for (const url of ours) expect(isIncomingMusicLink(url), url).toBe(true);
  });

  it('чужие не узнаёт: возврат из Discord, другие сайты, поддельные поддомены', () => {
    const foreign = [
      'wireon://auth/callback#access_token=abc&state=xyz',
      'discord-1539037027633332234://callback#access_token=abc',
      'https://vimeo.com/123456',
      'https://youtube.com.evil.example/watch?v=abc',
      'https://notyoutube.com/watch?v=abc',
      'https://soundcloud.com.evil.example/a/b',
      'ftp://youtube.com/watch?v=abc',
      'youtube.com/watch?v=abc',
      'https://',
      ''
    ];
    for (const url of foreign) expect(isIncomingMusicLink(url), url).toBe(false);
  });
});

describe('incomingLinks: ссылка попадает в поиск', () => {
  it('готовое приложение: ссылка в строке поиска, экран поиска, плеер и очередь закрыты', () => {
    expect(handleIncomingLink(`  ${TRACK}  `)).toBe(true);

    expect(ui().searchQuery).toBe(TRACK);
    expect(ui().activeView).toBe('search');
    expect(ui().isFullscreenPlayerOpen).toBe(false);
    expect(ui().isQueueOpen).toBe(false);
    expect(pendingIncomingLinks()).toBe(0);
  });

  it('чужая ссылка: отказ и ни одного изменения в сторе', () => {
    expect(handleIncomingLink('wireon://auth/callback#access_token=abc')).toBe(false);

    expect(ui().searchQuery).toBe('');
    expect(ui().activeView).toBe('home');
    expect(ui().isFullscreenPlayerOpen).toBe(true);
  });
});

describe('incomingLinks: очередь до готовности', () => {
  it('до восстановления сессии ссылка ждёт, а после — открывается сама', () => {
    notReady();

    expect(handleIncomingLink(TRACK)).toBe(true);
    expect(pendingIncomingLinks()).toBe(1);
    expect(ui().searchQuery).toBe('');
    expect(ui().activeView).toBe('home');

    // Восстановление идёт — всё ещё рано.
    useAuthStore.setState({ authStatus: 'authenticating' });
    expect(pendingIncomingLinks()).toBe(1);
    expect(ui().activeView).toBe('home');

    useAuthStore.setState({ authStatus: 'authenticated' });
    expect(pendingIncomingLinks()).toBe(0);
    expect(ui().searchQuery).toBe(TRACK);
    expect(ui().activeView).toBe('search');
  });

  it('из нескольких ждущих открывается последняя, повтор той же не копится', () => {
    notReady();
    const first = 'https://youtu.be/first000000';
    const last = 'https://soundcloud.com/artist/last';

    handleIncomingLink(first);
    handleIncomingLink(first);
    handleIncomingLink(last);
    expect(pendingIncomingLinks()).toBe(2);

    ready();
    expect(ui().searchQuery).toBe(last);
    expect(pendingIncomingLinks()).toBe(0);
  });

  it('сброс очереди: ручной слив ничего не открывает, когда ждать нечего', () => {
    flushIncomingLinks();
    expect(ui().activeView).toBe('home');
  });
});

describe('incomingLinks: подписка на переходы Capacitor', () => {
  it('вне телефона ничего не подписывает', async () => {
    pretendMobile(false);
    await startIncomingLinks();
    expect(fakeApp.listeners.size).toBe(0);
  });

  it('на телефоне: музыкальная ссылка уезжает в поиск, возврат из Discord — нет', async () => {
    pretendMobile(true);
    await startIncomingLinks();
    expect(fakeApp.listeners.get('appUrlOpen')?.length).toBe(1);

    fakeApp.emit('wireon://auth/callback#access_token=abc&state=xyz');
    expect(ui().searchQuery).toBe('');
    expect(ui().activeView).toBe('home');

    fakeApp.emit(TRACK);
    expect(ui().searchQuery).toBe(TRACK);
    expect(ui().activeView).toBe('search');
  });

  it('холодный запуск: адрес запуска открывается, а его же повтор событием — нет', async () => {
    pretendMobile(true);
    fakeApp.launchUrl = TRACK;
    await startIncomingLinks();
    expect(ui().searchQuery).toBe(TRACK);

    // Человек уже ушёл со страницы поиска; тот же адрес событием — не второе нажатие.
    useUIStore.setState({ searchQuery: '', activeView: 'home' });
    fakeApp.emit(TRACK);
    expect(ui().searchQuery).toBe('');
    expect(ui().activeView).toBe('home');

    // А другая ссылка — настоящее нажатие.
    fakeApp.emit('https://youtu.be/other0000000');
    expect(ui().searchQuery).toBe('https://youtu.be/other0000000');
  });

  it('повторный запуск отдаёт ту же подписку, отписка снимает её', async () => {
    pretendMobile(true);
    const stop = await startIncomingLinks();
    await startIncomingLinks();
    expect(fakeApp.listeners.get('appUrlOpen')?.length).toBe(1);

    stop();
    expect(fakeApp.removed).toBe(1);
    fakeApp.emit(TRACK);
    expect(ui().searchQuery).toBe('');
  });
});

describe('4.0: «Открыть в Wireon» со страницы «поделиться»', () => {
  it('wireon://track превращается в адрес источника, а чужие и битые — нет', async () => {
    const { wireonTrackLinkToSource } = await import('../../src/services/incomingLinks');
    expect(wireonTrackLinkToSource('wireon://track/yt/dQw4w9WgXcQ')).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(wireonTrackLinkToSource('wireon://track/sc/123?u=https%3A%2F%2Fsoundcloud.com%2Fkino%2Fkukushka')).toBe('https://soundcloud.com/kino/kukushka');
    // SoundCloud без адреса записи открыть нечем; чужой хост в `u` — тем более.
    expect(wireonTrackLinkToSource('wireon://track/sc/123')).toBeNull();
    expect(wireonTrackLinkToSource('wireon://track/sc/123?u=https%3A%2F%2Fevil.example%2Fx')).toBeNull();
    expect(wireonTrackLinkToSource('wireon://spotify?code=1')).toBeNull();
    expect(wireonTrackLinkToSource('wireon://track/yt/../etc')).toBeNull();
    expect(isIncomingMusicLink('wireon://track/yt/dQw4w9WgXcQ')).toBe(true);
  });

  it('открывается в поиске адресом источника', () => {
    resetIncomingLinks();
    useAuthStore.setState({ authStatus: 'guest' });
    expect(handleIncomingLink('wireon://track/yt/dQw4w9WgXcQ')).toBe(true);
    expect(useUIStore.getState().searchQuery).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(useUIStore.getState().activeView).toBe('search');
  });
});
