import { ICON } from '../../styles/icons';
import React, { useState } from 'react';
import { ArrowDown, ArrowUp, RotateCcw } from 'lucide-react';
import { useAppLayoutStore, PANEL_POSITIONS, TAB_LABELS, HOME_BLOCK_LABELS, AVAILABLE_HOME_BLOCKS, type LayoutPlatform } from '../../store/useAppLayoutStore';
import { useMobileShell } from '../../hooks/useMobileShell';
import { Button } from '../common/Button';
import '../../styles/appLayout.css';

const POSITION_LABELS = { top: 'Сверху', bottom: 'Снизу', left: 'Слева', right: 'Справа' };
export const AppLayoutSettings: React.FC = () => {
  const isMobile = useMobileShell();
  const [platform, setPlatform] = useState<LayoutPlatform>(isMobile ? 'mobile' : 'desktop');
  const layout = useAppLayoutStore((s) => s[platform]);
  const { update, move, toggle, reset } = useAppLayoutStore.getState();
  const blocks = layout.homeBlocks.filter((id) => AVAILABLE_HOME_BLOCKS[platform].includes(id));
  return (
    <section className="app-layout-settings" data-testid="app-layout-settings">
      <h2>Конструктор главной</h2>
      <p>Переставьте панели, вкладки и блоки. Изменения сохраняются сразу; у телефона и компьютера своя раскладка.</p>
      <div className="layout-choice" role="group" aria-label="Раскладка устройства">
        {(['desktop', 'mobile'] as const).map((id) => <button key={id} className="chip" aria-pressed={platform === id}
          onClick={() => setPlatform(id)}>{id === 'desktop' ? 'Компьютер' : 'Телефон'}</button>)}
      </div>
      {(['navigationPosition', 'playerPosition'] as const).map((key) => <fieldset key={key}>
        <legend>{key === 'navigationPosition' ? 'Навигация' : 'Плеер'}</legend>
        <div className="layout-choice">{PANEL_POSITIONS.map((position) => <button key={position} className="chip"
          aria-pressed={layout[key] === position} onClick={() => update(platform, { [key]: position })}
          data-testid={`layout-${key}-${position}`}>{POSITION_LABELS[position]}</button>)}</div>
      </fieldset>)}
      {platform === 'desktop' && <div className="layout-dimensions">
        {(['navigationWidth', 'playerWidth'] as const).map((key) => <label key={key}>
          {key === 'navigationWidth' ? 'Ширина боковой навигации' : 'Ширина бокового плеера'}: {layout[key]} px
          <input type="range" min={key === 'navigationWidth' ? 64 : 160} max={key === 'navigationWidth' ? 240 : 320}
            value={layout[key]} onChange={(e) => update(platform, { [key]: Number(e.target.value) })} />
        </label>)}
        <label>Колонки главной <select value={layout.homeColumns} onChange={(e) => update(platform, { homeColumns: Number(e.target.value) as 1 | 2 })}>
          <option value={1}>Одна</option><option value={2}>Две, когда хватает места</option></select></label>
      </div>}
      <h3>Вкладки</h3>
      <p>Перетащите строку или используйте стрелки. Главная всегда доступна.</p>
      {layout.tabs.map((id, index) => <div className="layout-order-row" key={id} draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', `tab:${id}`)} onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const item = e.dataTransfer.getData('text/plain'); if (item.startsWith('tab:')) move(platform, 'tabs', item.slice(4), index); }}>
        <label><input type="checkbox" checked={!layout.hiddenTabs.includes(id)} disabled={id === 'home'}
          onChange={() => toggle(platform, 'hiddenTabs', id)} />{TAB_LABELS[id]}</label>
        <OrderButtons label={TAB_LABELS[id]} index={index} length={layout.tabs.length} onMove={(to) => move(platform, 'tabs', id, to)} />
      </div>)}
      <h3>Блоки главной</h3>
      {blocks.map((id, index) => <div className="layout-order-row" key={id} draggable
        onDragStart={(e) => e.dataTransfer.setData('text/plain', `block:${id}`)} onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const item = e.dataTransfer.getData('text/plain'); if (item.startsWith('block:')) move(platform, 'homeBlocks', item.slice(6), layout.homeBlocks.indexOf(id)); }}>
        <label><input type="checkbox" checked={!layout.hiddenHomeBlocks.includes(id)} onChange={() => toggle(platform, 'hiddenHomeBlocks', id)} />{HOME_BLOCK_LABELS[id]}</label>
        <OrderButtons label={HOME_BLOCK_LABELS[id]} index={index} length={blocks.length} onMove={(to) => move(platform, 'homeBlocks', id, layout.homeBlocks.indexOf(blocks[to]))} />
      </div>)}
      <p>Блоки с музыкой появятся, когда для них есть история или подборки. Блоки также можно двигать прямо на главной кнопкой «Настроить главную».</p>
      <Button variant="ghost" style={{ whiteSpace: 'normal', minWidth: 0, textAlign: 'left' }} icon={<RotateCcw size={ICON.md} />} onClick={() => reset(platform)}>Сбросить раскладку {platform === 'mobile' ? 'телефона' : 'компьютера'}</Button>
    </section>
  );
};
const OrderButtons: React.FC<{ label: string; index: number; length: number; onMove: (to: number) => void }> = ({ label, index, length, onMove }) => (
  <div className="layout-order-buttons">
    <button aria-label={`${label}: выше`} disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowUp size={ICON.md} /></button>
    <button aria-label={`${label}: ниже`} disabled={index === length - 1} onClick={() => onMove(index + 1)}><ArrowDown size={ICON.md} /></button>
  </div>
);
