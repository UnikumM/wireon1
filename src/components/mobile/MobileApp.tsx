import React from 'react';
import { useUIStore } from '../../store/useUIStore';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Toast } from '../common/Toast';
import { WelcomeGate } from '../auth/WelcomeGate';
import { AccountPrompt } from '../auth/AccountPrompt';
import { WhatsNewGate } from '../common/WhatsNewGate';
import { CreatePlaylistModal } from '../library/CreatePlaylistModal';
import { QueueDrawer } from '../player/QueueDrawer';
import { ArtistHubView } from '../artist/ArtistHubView';
import { ForYouView } from '../foryou/ForYouView';
import { MobileHomeView } from './MobileHomeView';
import { MobileLibraryView } from './MobileLibraryView';
import { MobileSearchView } from './MobileSearchView';
import { MobilePlaylistView } from './MobilePlaylistView';
import { MobileSettingsView } from './MobileSettingsView';
import { MobileWaveView } from './MobileWaveView';
import { MobileFullscreenPlayer } from './MobileFullscreenPlayer';
import { MobileNavBar } from './MobileNavBar';
import { MobilePlayerBar } from './MobilePlayerBar';
import { TrackActionsSheet } from './TrackActionsSheet';

/**
 * Всё приложение на телефоне.
 *
 * Отдельное дерево, а не настольное с оговорками. Прежде «мобильным» считалось
 * узкое окно, и полсотни ветвлений `isNarrow` жили прямо внутри общих
 * компонентов: каждая правка ради телефона рисковала задеть ПК, а каждая
 * телефонная находка упиралась в чужую разметку.
 *
 * **Раскладка — обычный поток, без `position: fixed`.** Прежняя оболочка
 * держала полосу плеера и нижнюю панель приколотыми к окну, а нижний отступ
 * прокручиваемой области считала формулой из четырёх переменных
 * (`--player-bar-space + --mobile-nav-height + --safe-bottom + --space-6`),
 * причём та же формула была продублирована в `Toast`. Стоило одному слагаемому
 * поменяться — и низ списка уезжал под плеер. Здесь колонка высотой
 * `--app-height`: список забирает остаток, плеер и панель просто стоят под ним
 * и всегда занимают ровно столько, сколько занимают.
 *
 * `--app-height`, а не `100vh`: на телефоне адресная строка то появляется, то
 * исчезает, и `100vh` больше настоящего экрана — низ панели оказался бы за
 * краем.
 */
export const MobileApp: React.FC = () => {
  const activeView = useUIStore((s) => s.activeView);
  const actionsTrack = useUIStore((s) => s.actionsTrack);
  const closeTrackActions = useUIStore((s) => s.closeTrackActions);
  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = React.useState(false);

  const renderActiveView = () => {
    switch (activeView) {
      case 'home':
        return <MobileHomeView />;
      case 'foryou':
        return <ForYouView />;
      case 'wave':
        return <MobileWaveView />;
      case 'library':
      case 'favorites':
      case 'playlists':
      case 'offline':
        return <MobileLibraryView onCreatePlaylistClick={() => setIsCreatePlaylistOpen(true)} />;
      case 'playlist':
        return <MobilePlaylistView />;
      case 'settings':
        return <MobileSettingsView />;
      case 'artist':
        return <ArtistHubView scrollSelf={false} />;
      case 'search':
      default:
        return <MobileSearchView />;
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: 'var(--app-height)',
        width: '100%',
        overflow: 'hidden',
        background: 'var(--bg-base)'
      }}
      data-testid="mobile-app"
    >
      <main
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          // Безопасная зона сверху — часть отступа содержимого, а не отдельной
          // шапки: своей шапки у телефона нет, каждый экран рисует верх сам.
          paddingTop: 'calc(var(--safe-top) + var(--space-4))',
          paddingLeft: 'calc(var(--safe-left) + var(--space-4))',
          paddingRight: 'calc(var(--safe-right) + var(--space-4))',
          paddingBottom: 'var(--space-6)'
        }}
        data-testid="main-content"
      >
        <ErrorBoundary key={activeView}>{renderActiveView()}</ErrorBoundary>
      </main>

      <MobilePlayerBar />
      <MobileNavBar />

      {/*
        * Слои поверх приложения. Лист действий живёт здесь, а не внутри строки
        * трека: потомок прокручиваемого списка обрезался бы им, а в
        * виртуализированном списке исчезал бы вместе с уехавшей строкой.
        */}
      <TrackActionsSheet track={actionsTrack} onClose={closeTrackActions} />
      <MobileFullscreenPlayer />
      <QueueDrawer />
      <CreatePlaylistModal isOpen={isCreatePlaylistOpen} onClose={() => setIsCreatePlaylistOpen(false)} />
      <WelcomeGate />
      <AccountPrompt />
      <WhatsNewGate />
      <Toast />
    </div>
  );
};
