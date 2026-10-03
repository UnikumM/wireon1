import React from 'react';
import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { Toast } from '../common/Toast';
import { CommandPalette } from '../common/CommandPalette';
import { UpdateBanner } from '../common/UpdateBanner';
import { ParticleField } from '../fx';
import { useThemeStore } from '../../store/useThemeStore';
import { resolveParticles } from '../../styles/presets';
import { useAppLayoutStore } from '../../store/useAppLayoutStore';
import { CustomAppFrame } from './CustomAppFrame';
import { TopNav } from './TopNav';
import { SidePlayer } from '../player/SidePlayer';

export interface AppShellProps {
  children: React.ReactNode;
  playerBarSlot?: React.ReactNode;
  queueDrawerSlot?: React.ReactNode;
  fullscreenPlayerSlot?: React.ReactNode;
  modalSlot?: React.ReactNode;
}

/**
 * Frame around every view: header with the section nav, scrolling main region
 * and the global overlay mounts. The grain layer and the toast region live here
 * so they exist exactly once, whatever the active view is.
 *
 * Navigation and player edges follow the independently saved desktop layout.
 */
export const AppShell: React.FC<AppShellProps> = ({
  children,
  playerBarSlot,
  queueDrawerSlot,
  fullscreenPlayerSlot,
  modalSlot
}) => {
  const layout = useAppLayoutStore((s) => s.desktop);
  const sidePlayer = layout.playerPosition === 'left' || layout.playerPosition === 'right';
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
          <Header showNavigation={layout.navigationPosition === 'top'} />

          {/* Тонкая полоса «обновление готово». Сама решает, показываться ли. */}
          <UpdateBanner />

          <CustomAppFrame layout={layout} platform="desktop"
            navigation={layout.navigationPosition === 'top' ? null : <TopNav />}
            player={sidePlayer ? <SidePlayer /> : playerBarSlot}>

          <main
            className="scrollbar-thin"
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: 'var(--space-6) var(--content-pad-x)',
              // Panels occupy their own frame space; only the content gutter remains.
              paddingBottom: 'var(--space-6)',
              position: 'relative'
            }}
            data-testid="main-content"
          >
            {children}
          </main>

          <MobileNav />
          </CustomAppFrame>
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
