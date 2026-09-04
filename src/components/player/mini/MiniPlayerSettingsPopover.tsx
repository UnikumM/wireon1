import React from 'react';
import { Sliders, Pin, PinOff, AudioLines, SlidersHorizontal, Layers, X } from 'lucide-react';
import { useUIStore } from '../../../store/useUIStore';
import { ICON } from '../../../styles/icons';

export interface MiniPlayerSettingsPopoverProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Пределы прозрачности окна, в процентах.
 *
 * Названы, потому что нужны в трёх местах: границы ползунка, шаг и доля
 * заливки. Ниже сорока окно перестаёт быть окном — сквозь него видно чужой
 * текст, и попасть по собственной кнопке нельзя.
 */
const OPACITY_MIN = 40;
const OPACITY_MAX = 100;

export const MiniPlayerSettingsPopover: React.FC<MiniPlayerSettingsPopoverProps> = ({ isOpen, onClose }) => {
  const miniPlayerOpacity = useUIStore((s) => s.miniPlayerOpacity);
  const miniPlayerAlwaysOnTop = useUIStore((s) => s.miniPlayerAlwaysOnTop);
  const miniPlayerShowVisualizer = useUIStore((s) => s.miniPlayerShowVisualizer);
  const miniPlayerShowProgress = useUIStore((s) => s.miniPlayerShowProgress);

  const setMiniPlayerOpacity = useUIStore((s) => s.setMiniPlayerOpacity);
  const setMiniPlayerAlwaysOnTop = useUIStore((s) => s.setMiniPlayerAlwaysOnTop);
  const setMiniPlayerShowVisualizer = useUIStore((s) => s.setMiniPlayerShowVisualizer);
  const setMiniPlayerShowProgress = useUIStore((s) => s.setMiniPlayerShowProgress);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-overlay)' }}
        onClick={onClose}
        data-testid="mini-settings-backdrop"
      />

      <div
        className="panel-raised animate-pop-in scrollbar-thin"
        style={{
          position: 'absolute',
          top: '36px',
          right: '8px',
          width: '260px',
          padding: 'var(--space-3)',
          // Поповер — матовое стекло, поэтому берёт стеклянный токен: только
          // тема знает, «мутный» здесь тёмный или белый. Зашитый почти-чёрный
          // оставался тёмным и на светлой теме, где съедал собственный текст.
          backgroundColor: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--border-accent)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          // Слои взяты числами из темы, а не пятизначными литералами: поповер
          // лежит внутри мини-плеера, у которого свой слой, так что это порядок
          // внутри него — «подложка» под «меню», как везде в приложении.
          zIndex: 'var(--z-menu)',
          userSelect: 'none'
        }}
        data-testid="mini-player-settings-popover"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--space-3)',
            paddingBottom: 'var(--space-2)',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Sliders size={ICON.sm} style={{ color: 'var(--text-secondary)' }} />
            Настройки мини-плеера
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
            aria-label="Закрыть"
          >
            <X size={ICON.sm} />
          </button>
        </div>

        {/* Opacity Slider */}
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '4px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Layers size={ICON.xs} /> Прозрачность
            </span>
            <span data-numeric style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>
              {Math.round(miniPlayerOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={OPACITY_MIN}
            max={OPACITY_MAX}
            step="5"
            value={Math.round(miniPlayerOpacity * 100)}
            onChange={(e) => setMiniPlayerOpacity(parseInt(e.target.value, 10) / 100)}
            style={
              {
                width: '100%',
                cursor: 'pointer',
                /*
                 * Доля заливки, а не оформление: облик дорожки — одно правило в
                 * global.css. Пределы у ползунка от 40 до 100, поэтому доля
                 * считается от них, а не от процентов прозрачности: иначе на
                 * самом левом положении дорожка была бы залита на 40%, а бегунок
                 * стоял бы в начале.
                 */
                '--range-fill': `${Math.round(
                  ((Math.round(miniPlayerOpacity * 100) - OPACITY_MIN) / (OPACITY_MAX - OPACITY_MIN)) * 100
                )}%`
              } as React.CSSProperties
            }
            data-testid="mini-opacity-slider"
          />
        </div>

        {/* Always on top toggle */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <button
            type="button"
            onClick={() => void setMiniPlayerAlwaysOnTop(!miniPlayerAlwaysOnTop)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              // Состояние «выкл» — тот же спокойный wash, что у любого другого
              // покоящегося элемента, и он следует полярности темы: белый по
              // тёмному здесь, тёмный по белому на светлой. Литеральная белизна
              // на белой панели просто исчезала.
              backgroundColor: miniPlayerAlwaysOnTop ? 'var(--accent-soft)' : 'var(--surface-hover)',
              border: `1px solid ${miniPlayerAlwaysOnTop ? 'var(--border-accent)' : 'transparent'}`,
              color: miniPlayerAlwaysOnTop ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
              textAlign: 'left'
            }}
            aria-pressed={miniPlayerAlwaysOnTop}
            data-testid="mini-always-on-top-btn"
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {miniPlayerAlwaysOnTop ? <Pin size={ICON.sm} style={{ color: 'var(--accent)' }} /> : <PinOff size={ICON.sm} />}
              Поверх всех окон
            </span>
            {/*
              * Строчными: «ВКЛ» кричало ровно там, где от подписи требуется лишь
              * подтвердить состояние. Само состояние держится не на ней — у кнопки
              * есть `aria-pressed`, а до этого его сообщал только цвет.
              */}
            <span style={{ color: miniPlayerAlwaysOnTop ? 'var(--accent)' : 'var(--text-muted)' }}>
              {miniPlayerAlwaysOnTop ? 'Вкл' : 'Выкл'}
            </span>
          </button>

          {/* Show Visualizer */}
          <button
            type="button"
            onClick={() => setMiniPlayerShowVisualizer(!miniPlayerShowVisualizer)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: miniPlayerShowVisualizer ? 'var(--accent-soft)' : 'var(--surface-hover)',
              border: `1px solid ${miniPlayerShowVisualizer ? 'var(--border-accent)' : 'transparent'}`,
              color: miniPlayerShowVisualizer ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
              textAlign: 'left'
            }}
            aria-pressed={miniPlayerShowVisualizer}
            data-testid="mini-visualizer-toggle-btn"
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {/* Не Sparkles: пункт про полосы, отзывающиеся на звук, — они и нарисованы. */}
              <AudioLines size={ICON.sm} style={{ color: miniPlayerShowVisualizer ? 'var(--accent)' : 'inherit' }} />
              Визуализатор звука
            </span>
            <span style={{ color: miniPlayerShowVisualizer ? 'var(--accent)' : 'var(--text-muted)' }}>
              {miniPlayerShowVisualizer ? 'Вкл' : 'Выкл'}
            </span>
          </button>

          {/* Show Progress */}
          <button
            type="button"
            onClick={() => setMiniPlayerShowProgress(!miniPlayerShowProgress)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 8px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: miniPlayerShowProgress ? 'var(--accent-soft)' : 'var(--surface-hover)',
              border: `1px solid ${miniPlayerShowProgress ? 'var(--border-accent)' : 'transparent'}`,
              color: miniPlayerShowProgress ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
              textAlign: 'left'
            }}
            aria-pressed={miniPlayerShowProgress}
            data-testid="mini-progress-toggle-btn"
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <SlidersHorizontal size={ICON.sm} style={{ color: miniPlayerShowProgress ? 'var(--accent)' : 'inherit' }} />
              Полоса перемотки
            </span>
            <span style={{ color: miniPlayerShowProgress ? 'var(--accent)' : 'var(--text-muted)' }}>
              {miniPlayerShowProgress ? 'Вкл' : 'Выкл'}
            </span>
          </button>
        </div>
      </div>
    </>
  );
};
