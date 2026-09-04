import React from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { Toast } from '../common/Toast';
import { CommandPalette } from '../common/CommandPalette';
import { UpdateBanner } from '../common/UpdateBanner';
import { ParticleField } from '../fx';
import { useThemeStore } from '../../store/useThemeStore';
import { resolveParticles } from '../../styles/presets';

export interface AppShellProps {
  children: React.ReactNode;
  playerBarSlot?: React.ReactNode;
  queueDrawerSlot?: React.ReactNode;
  fullscreenPlayerSlot?: React.ReactNode;
  modalSlot?: React.ReactNode;
  onCreatePlaylistClick?: () => void;
}

/**
 * Frame around every view: sidebar, header, scrolling main region and the
 * global overlay mounts. The grain layer and the toast region live here so they
 * exist exactly once, whatever the active view is.
 */
export const AppShell: React.FC<AppShellProps> = ({
  children,
  playerBarSlot,
  queueDrawerSlot,
  fullscreenPlayerSlot,
  modalSlot,
  onCreatePlaylistClick
}) => {
  /*
   * Профиль частиц выбирается пресетом, а ручка настроек его перебивает —
   * `resolveParticles` знает этот порядок. Подписка идёт на готовое значение, а
   * не на весь стор: смена акцента или кегля не должна перерисовывать холст,
   * иначе каждая правка в настройках оформления сбрасывает все частицы в
   * начальные положения.
   */
  const particles = useThemeStore((state) =>
    resolveParticles({ presetId: state.presetId, overrides: state.overrides })
  );

  return (
    /*
     * Фрагмент, а не один корневой узел: холст частиц обязан быть СЕСТРОЙ
     * оболочки, а не её ребёнком. Он лежит на `--z-particles`, оболочка — выше
     * (`.wireon-app-shell` в global.css), и порядок между ними разбирает `#root`.
     * Ребёнком оболочки холст с тем же z-index оказался бы над её содержимым:
     * позиционированные братья без z-index рисуются ниже любого слоя с числом.
     */
    <>
      <ParticleField profile={particles} />

      <div
        className="wireon-app-shell"
        style={{
          display: 'flex',
          width: '100%',
          // Не `100vh`: на телефоне это высота окна с раскрытыми панелями
          // браузера, и низ приложения уезжает под них — нижняя навигация
          // оказывается за краем экрана. `--app-height` берёт `100dvh` там,
          // где движок его понимает, и остаётся на `100vh` там, где нет.
          height: 'var(--app-height)',
          // Фона здесь нет нарочно: его рисует `body`. Непрозрачная оболочка
          // закрыла бы и холст частиц, и подсвет верха `#root::before` — оба
          // слоя лежат под ней.
          color: 'var(--text-primary)',
          overflow: 'hidden',
          position: 'relative'
        }}
        data-testid="app-shell"
      >
        <Sidebar onCreatePlaylistClick={onCreatePlaylistClick} />

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            height: '100%',
            overflow: 'hidden',
            position: 'relative'
          }}
        >
          <Header />

          {/* Тонкая полоса «обновление готово». Сама решает, показываться ли. */}
          <UpdateBanner />

          <main
            className="scrollbar-thin"
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: 'var(--space-6) var(--content-pad-x)',
              // Под полосой плеера и — на узком окне — под нижней навигацией
              // должно оставаться место, иначе последний трек списка не
              // доскроллить: обе панели фиксированы и лежат поверх содержимого.
              // На широком окне `--mobile-nav-height` равна нулю.
              // `--safe-bottom` здесь не для красоты: нижняя навигация
              // добавляет его к своей высоте, чтобы кнопки не попали под
              // полосу жеста, — значит и место под ней надо считать вместе с
              // ним, иначе последняя строка списка прячется ровно на эту
              // величину.
              paddingBottom:
                'calc(var(--player-bar-space) + var(--mobile-nav-height) + var(--safe-bottom) + var(--space-6))',
              position: 'relative'
            }}
            data-testid="main-content"
          >
            {children}
          </main>

          {playerBarSlot}

          <MobileNav />
        </div>

        {queueDrawerSlot}
        {fullscreenPlayerSlot}
        {modalSlot}

        <CommandPalette />
        <Toast />

        {/*
          * Пар темы «Дымка». Стоит здесь, а не в поле частиц, по одной причине:
          * поле лежит ПОД интерфейсом, а пар должен висеть между глазом и
          * картинкой — иначе его не видно вовсе. Показывается только при
          * `data-preset='haze'`, остальным темам это пустой `div` без слоя.
          */}
        <div className="haze-steam" aria-hidden="true" />

        {/* Film grain. Mounted once, above everything, never interactive. */}
        <div className="grain" aria-hidden="true" />
      </div>
    </>
  );
};
