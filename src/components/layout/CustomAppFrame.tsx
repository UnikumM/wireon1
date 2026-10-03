import React from 'react';
import type { AppLayout, LayoutPlatform } from '../../store/useAppLayoutStore';
import '../../styles/appLayout.css';

export const CustomAppFrame: React.FC<{ layout: AppLayout; platform: LayoutPlatform;
  navigation: React.ReactNode; player: React.ReactNode; children: React.ReactNode }> = ({ layout, platform, navigation, player, children }) => {
  const side = (position: 'top' | 'bottom' | 'left' | 'right') => <>
    {position === 'bottom' && layout.playerPosition === position && player && <div className="layout-panel layout-player" data-position={position}>{player}</div>}
    {layout.navigationPosition === position && navigation && <div className="layout-panel layout-nav" data-position={position}>{navigation}</div>}
    {position !== 'bottom' && layout.playerPosition === position && player && <div className="layout-panel layout-player" data-position={position}>{player}</div>}
  </>;
  return <div className="custom-app-frame" data-platform={platform} style={{
    '--layout-nav-width': `${layout.navigationWidth}px`, '--layout-player-width': `${layout.playerWidth}px`
  } as React.CSSProperties}>
    <div className="layout-edge layout-top">{side('top')}</div>
    <div className="layout-body">
      <aside className="layout-edge layout-left">{side('left')}</aside>
      <div className="layout-content">{children}</div>
      <aside className="layout-edge layout-right">{side('right')}</aside>
    </div>
    <div className="layout-edge layout-bottom">{side('bottom')}</div>
  </div>;
};
