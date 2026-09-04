import React, { useState } from 'react';
import { Pin, PinOff, Sliders, Maximize2, Square, StretchHorizontal, Columns3 } from 'lucide-react';
import { useUIStore } from '../../../store/useUIStore';
import { MiniPlayerCompact } from './MiniPlayerCompact';
import { MiniPlayerSquare } from './MiniPlayerSquare';
import { MiniPlayerExpanded } from './MiniPlayerExpanded';
import { MiniPlayerSettingsPopover } from './MiniPlayerSettingsPopover';
import { MiniPlayerLayout } from '../../../types/store';
import { ICON } from '../../../styles/icons';
import { Button } from '../../common/Button';

/**
 * Рамка кнопки планки.
 *
 * Ровно та же ступень, что и высота планки: подсветка наведения у кнопки
 * прямоугольная, и коробка выше полосы вылезала бы за её край. Пара
 * `--control-sm` (28px) с `ICON.sm` (14px) даёт целый зазор, поэтому глиф не
 * съезжает с центра на полпикселя.
 */
const HEADER_BUTTON: React.CSSProperties = {
  width: 'var(--control-sm)',
  height: 'var(--control-sm)'
};

export const MiniPlayerView: React.FC = () => {
  const isMiniPlayerOpen = useUIStore((s) => s.isMiniPlayerOpen);
  const miniPlayerLayout = useUIStore((s) => s.miniPlayerLayout);
  const miniPlayerAlwaysOnTop = useUIStore((s) => s.miniPlayerAlwaysOnTop);
  const miniPlayerOpacity = useUIStore((s) => s.miniPlayerOpacity);

  const setMiniPlayerOpen = useUIStore((s) => s.setMiniPlayerOpen);
  const setMiniPlayerLayout = useUIStore((s) => s.setMiniPlayerLayout);
  const setMiniPlayerAlwaysOnTop = useUIStore((s) => s.setMiniPlayerAlwaysOnTop);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  if (!isMiniPlayerOpen) return null;

  const handleClose = () => {
    void setMiniPlayerOpen(false);
  };

  const handleLayoutChange = (layout: MiniPlayerLayout) => {
    void setMiniPlayerLayout(layout);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        // Прозрачность задаёт человек ползунком, поэтому цвет собирается через
        // color-mix: токен хранит hex, а hex не подставить внутрь rgba(), чтобы
        // дописать альфу. Так базовый тон принадлежит теме, а не зашитому
        // почти-чёрному, который раньше переживал любое переключение тем.
        backgroundColor: `color-mix(in srgb, var(--bg-base) ${Math.round(miniPlayerOpacity * 100)}%, transparent)`,
        // Размытие — тот же токен, что у стеклянных поверхностей приложения. На
        // светлой теме он ещё и снижает насыщенность: зашитый saturate(180%)
        // делал просвечивающую подложку кислотной там, где остальное стекло
        // оставалось спокойным.
        backdropFilter: 'var(--glass-blur)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 'var(--z-mini)',
        userSelect: 'none',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)'
      }}
      data-testid="mini-player-view"
    >
      {/* Titlebar / Drag Region */}
      <div
        style={{
          height: 'var(--control-sm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 var(--space-2)',
          // Планка отделена от тела прозрачным washем, а не чёрным: токен
          // переворачивает полярность вместе с темой, поэтому кнопки читаются и
          // на тёмном окне, и на светлом. Зашитый чёрный оставлял на светлой
          // теме тёмную полосу с бледными иконками.
          backgroundColor: 'var(--surface-active)',
          borderBottom: '1px solid var(--border-subtle)',
          WebkitAppRegion: 'drag',
          flexShrink: 0
        }}
        data-testid="mini-player-header"
      >
        {/* Left: Drag indicator & Layout Switcher */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            WebkitAppRegion: 'no-drag'
          }}
        >
          {/*
            Выбранный вид отмечается `isActive`, а не инлайновым цветом. Инлайн в
            этом проекте старше правила таблицы стилей, поэтому цвет покоя,
            написанный здесь, глушил бы `:hover` у `.wireon-btn`: кнопки объявляли
            переход цвета и не отвечали на наведение вовсе.
          */}
          <Button
            variant="icon"
            onClick={() => handleLayoutChange('compact')}
            isActive={miniPlayerLayout === 'compact'}
            style={HEADER_BUTTON}
            title="Компактный бар"
            aria-label="Компактный бар"
            data-testid="mini-layout-compact-btn"
          >
            <StretchHorizontal size={ICON.sm} />
          </Button>

          <Button
            variant="icon"
            onClick={() => handleLayoutChange('square')}
            isActive={miniPlayerLayout === 'square'}
            style={HEADER_BUTTON}
            title="Квадратная обложка"
            aria-label="Квадратная обложка"
            data-testid="mini-layout-square-btn"
          >
            <Square size={ICON.sm} />
          </Button>

          <Button
            variant="icon"
            onClick={() => handleLayoutChange('expanded')}
            isActive={miniPlayerLayout === 'expanded'}
            style={HEADER_BUTTON}
            title="Расширенный вид"
            aria-label="Расширенный вид"
            data-testid="mini-layout-expanded-btn"
          >
            <Columns3 size={ICON.sm} />
          </Button>
        </div>

        {/* Right: Actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            WebkitAppRegion: 'no-drag'
          }}
        >
          {/* Always on top toggle */}
          <Button
            variant="icon"
            onClick={() => void setMiniPlayerAlwaysOnTop(!miniPlayerAlwaysOnTop)}
            isActive={miniPlayerAlwaysOnTop}
            aria-pressed={miniPlayerAlwaysOnTop}
            style={HEADER_BUTTON}
            title={miniPlayerAlwaysOnTop ? 'Закреплено поверх окон' : 'Закрепить поверх окон'}
            aria-label={miniPlayerAlwaysOnTop ? 'Закреплено поверх окон' : 'Закрепить поверх окон'}
            data-testid="mini-header-pin-btn"
          >
            {miniPlayerAlwaysOnTop ? <Pin size={ICON.sm} fill="currentColor" /> : <PinOff size={ICON.sm} />}
          </Button>

          {/* Settings */}
          <Button
            variant="icon"
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            isActive={isSettingsOpen}
            aria-expanded={isSettingsOpen}
            style={HEADER_BUTTON}
            title="Настройки мини-плеера"
            aria-label="Настройки мини-плеера"
            data-testid="mini-header-settings-btn"
          >
            <Sliders size={ICON.sm} />
          </Button>

          {/*
            Одна кнопка выхода, а не две. Раньше рядом стояли «развернуть» и
            «закрыть», и обе звали один и тот же handleClose: мини-плеер здесь
            занимает всё окно приложения, поэтому «закрыть» его — это и есть
            «вернуться в полное окно». Крестик обещал закрытие программы и не
            делал его, а два одинаковых действия подряд заставляли выбирать
            между ними на пустом месте.
          */}
          <Button
            variant="icon"
            onClick={handleClose}
            style={HEADER_BUTTON}
            title="Развернуть в полное окно"
            aria-label="Развернуть в полное окно"
            data-testid="mini-header-expand-btn"
          >
            <Maximize2 size={ICON.sm} />
          </Button>
        </div>
      </div>

      {/* Main Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {miniPlayerLayout === 'compact' && <MiniPlayerCompact />}
        {miniPlayerLayout === 'square' && <MiniPlayerSquare />}
        {miniPlayerLayout === 'expanded' && <MiniPlayerExpanded />}

        <MiniPlayerSettingsPopover
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
        />
      </div>
    </div>
  );
};
