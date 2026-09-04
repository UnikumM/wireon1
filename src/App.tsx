import React, { useEffect, useState } from 'react';
import './styles/global.css';

import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { SearchResults } from './components/search/SearchResults';
import { LibraryView } from './components/library/LibraryView';
import { PlaylistView } from './components/library/PlaylistView';
import { CreatePlaylistModal } from './components/library/CreatePlaylistModal';
import { SettingsView } from './components/settings/SettingsView';
import { WaveView } from './components/wave/WaveView';
import { ForYouView } from './components/foryou/ForYouView';
import { ArtistHubView } from './components/artist/ArtistHubView';
import { PlayerBar } from './components/player/PlayerBar';
import { QueueDrawer } from './components/player/QueueDrawer';
import { FullscreenPlayer } from './components/player/FullscreenPlayer';
import { MiniPlayerView } from './components/player/mini';
import { WelcomeGate } from './components/auth/WelcomeGate';
import { AccountPrompt } from './components/auth/AccountPrompt';
import { WhatsNewGate } from './components/common/WhatsNewGate';
import { MobileApp } from './components/mobile/MobileApp';

import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useMediaKeys } from './hooks/useMediaKeys';
import { useMiniPlayerHost } from './hooks/useMiniPlayerHost';
import { useSessionWatch } from './hooks/useSessionWatch';
import { useUIStore } from './store/useUIStore';
import { useMobileShell } from './hooks/useMobileShell';
import { useLibraryStore } from './store/useLibraryStore';
import { useAuthStore } from './store/useAuthStore';
import { usePlayerStore } from './store/usePlayerStore';
import { useThemeStore } from './store/useThemeStore';
import { cloudSyncEngine } from './services/cloudSync';
import { onBackgroundAudioCommand, stopBackgroundAudio } from './services/backgroundAudio';
import { migrateLegacyDatabase } from './services/db';
import { streamResolver } from './services/streamResolver';
import { youtubeCookiesService } from './services/youtubeCookies';

export const App: React.FC = () => {
  const activeView = useUIStore((s) => s.activeView);
  const playbackError = usePlayerStore((s) => s.error);

  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false);

  useKeyboardShortcuts();
  useMediaKeys();
  useMiniPlayerHost();
  useSessionWatch();

  // Boot once. Reading the stores through `getState()` keeps sign-in and
  // sign-out from re-running persistence loading and restarting the sync timer.
  useEffect(() => {
    // Оформление восстанавливается первым: пока цвет и глубина не применены,
    // окно показывает значения по умолчанию из CSS, и выбранная тема въезжает
    // вспышкой. Здесь только чтение базы, всё остальное ждать не заставляет.
    void useThemeStore.getState().hydrateTheme();
    // The rename from VireonMusic to Wireon moved both the userData folder and
    // the database name, so a pre-rename library has to be pulled across before
    // anything reads it — otherwise the user sees an empty library and reloads.
    void migrateLegacyDatabase()
      .catch(() => 0)
      .then(() => useLibraryStore.getState().loadInitialData());
    void usePlayerStore.getState().hydrateSettings();
    /*
     * Разобранные ссылки переживают перезапуск.
     *
     * Разбор трека на телефоне занимает секунды (замерено: 35 с на эмуляторе,
     * 9,5 с на настольной машине), а сама ссылка живёт около шести часов. Пока
     * кэш жил только в памяти, каждый запуск начинался с нуля — включил вечером
     * то же, что слушал днём, и снова ждёшь.
     */
    void streamResolver.hydrateCache();
    // Выбор источника cookies живёт в настройках, а нужен main-процессу: каждый
    // запуск он начинает без него, поэтому выбор повторяется при загрузке.
    void youtubeCookiesService.init();

    /*
     * yt-dlp на телефоне обновляется сам, раз в сутки и в фоне.
     *
     * В библиотеке лежит та версия, что была на момент её выпуска: при первой
     * проверке это оказался yt-dlp девятимесячной давности. YouTube ломает
     * разбор раз в несколько месяцев, а yt-dlp чинит это за дни — и это
     * единственная часть приложения, которая умеет починиться без выпуска
     * новой сборки.
     */
    void import('./services/ytDlpOnDevice').then(({ maybeUpdateYtDlp }) => maybeUpdateYtDlp());

    useAuthStore
      .getState()
      .restoreSession()
      .catch(() => {
        useAuthStore.getState().continueAsGuest();
      });

    /*
     * Самосверку заводит вход (`useAuthStore.attachRemote`), а не запуск.
     * Здесь она отказывалась заводиться всегда: в эту минуту сессия ещё не
     * восстановлена, удалённой стороны нет, и движок честно отвечал «сервер не
     * настроен». Остановка при выходе из приложения по-прежнему нужна.
     */

    /*
     * Кнопки уведомления и экрана блокировки.
     *
     * Команда идёт в тот же стор, что и нажатие на экране: очередь, повтор и
     * «Моя волна» живут там. Нативная сторона намеренно ничего не решает сама —
     * второй плеер пришлось бы согласовывать с первым.
     */
    const unsubscribeBackground = onBackgroundAudioCommand((command) => {
      const player = usePlayerStore.getState();
      if (command === 'play' || command === 'pause') player.togglePlayPause();
      else if (command === 'next') void player.nextTrack();
      else if (command === 'prev') void player.prevTrack();
    });

    return () => {
      cloudSyncEngine.stopPeriodicSync();
      unsubscribeBackground();
      // Уведомление снимается вместе с приложением: оставленное, оно обещает
      // пульт, за которым уже никого нет.
      // Без отсрочки: приложение уходит, ждать возвращения уже некому.
      void stopBackgroundAudio({ immediate: true });
    };
  }, []);

  // Playback failures are stored rather than thrown, so the shell is what turns
  // them into something the user actually sees.
  useEffect(() => {
    if (playbackError) {
      useUIStore.getState().showToast(playbackError, 'error');
    }
  }, [playbackError]);

  const renderActiveView = () => {
    switch (activeView) {
      case 'search':
        return <SearchResults />;
      case 'wave':
        return <WaveView />;
      // `home` — маршрут телефонной ленты. Отдельного экрана под неё на широком
      // окне нет, и она ведёт в «Для вас»: содержимое то же, собранное для мыши.
      // Без этой строки окно, расширенное с телефонной ширины, теряло бы место.
      case 'home':
      case 'foryou':
        return <ForYouView />;
      case 'library':
      case 'favorites':
      case 'playlists':
      case 'offline':
        return <LibraryView onCreatePlaylistClick={() => setIsCreatePlaylistOpen(true)} />;
      case 'playlist':
        return <PlaylistView />;
      case 'settings':
        return <SettingsView />;
      case 'artist':
        return <ArtistHubView />;
      default:
        return <SearchResults />;
    }
  };

  const isMiniPlayerOpen = useUIStore((s) => s.isMiniPlayerOpen);
  const miniWindowActive = useUIStore((s) => s.miniWindowActive);
  const isMobileShell = useMobileShell();

  // With a separate mini window the main window keeps its normal contents — it is
  // still the one playing audio, and hiding it would strand every other view.
  if (isMiniPlayerOpen && !miniWindowActive) {
    return (
      <ErrorBoundary>
        <MiniPlayerView />
      </ErrorBoundary>
    );
  }

  /*
   * Телефон получает своё дерево целиком.
   *
   * Развилка стоит здесь, а не внутри экранов, ровно потому, что раньше стояла
   * внутри: полсотни ветвлений `isNarrow` по десяти файлам делали настольные
   * компоненты ответственными ещё и за телефон. Здесь настольная ветка ниже
   * про телефон не знает вовсе — и наоборот.
   */
  if (isMobileShell) {
    return (
      <ErrorBoundary>
        <MobileApp />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <AppShell
        playerBarSlot={<PlayerBar />}
        queueDrawerSlot={<QueueDrawer />}
        fullscreenPlayerSlot={<FullscreenPlayer />}
        modalSlot={
          <>
            <CreatePlaylistModal isOpen={isCreatePlaylistOpen} onClose={() => setIsCreatePlaylistOpen(false)} />
            {/* Приглашение при первом запуске: само решает, показываться ли. */}
            <WelcomeGate />
            <AccountPrompt />
            {/* Список изменений после обновления — тоже сам решает. */}
            <WhatsNewGate />
          </>
        }
        onCreatePlaylistClick={() => setIsCreatePlaylistOpen(true)}
      >
        <ErrorBoundary key={activeView}>{renderActiveView()}</ErrorBoundary>
      </AppShell>
    </ErrorBoundary>
  );
};

export default App;
