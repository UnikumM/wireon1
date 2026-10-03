import { ICON } from '../../styles/icons';
import React from 'react';
import { ArrowDown, ArrowUp, EyeOff, GripVertical, SlidersHorizontal } from 'lucide-react';
import { useAppLayoutStore, HOME_BLOCK_LABELS, type HomeBlockId, type LayoutPlatform } from '../../store/useAppLayoutStore';
import { useUIStore } from '../../store/useUIStore';
import '../../styles/appLayout.css';

export const HomeLayout: React.FC<{ platform: LayoutPlatform; children: React.ReactNode; testId: string }> = ({ platform, children, testId }) => {
  const layout = useAppLayoutStore((s) => s[platform]);
  const editing = useAppLayoutStore((s) => s.editHome);
  const { move, toggle, setEditHome } = useAppLayoutStore.getState();
  const childrenArray = React.Children.toArray(children);
  const renderedIds = childrenArray.flatMap((child) => {
    if (!React.isValidElement(child)) return [];
    const props = child.props as { 'data-home-block'?: HomeBlockId; homeBlock?: HomeBlockId };
    const id = props['data-home-block'] ?? props.homeBlock;
    return id ? [id] : [];
  });
  const visibleBlocks = layout.homeBlocks.filter((id) => renderedIds.includes(id) && !layout.hiddenHomeBlocks.includes(id));
  return <div className="home-builder" data-testid={testId} data-columns={platform === 'desktop' ? layout.homeColumns : 1}>
    <div className="home-builder-tools">
      <button className="chip" aria-pressed={editing} onClick={() => setEditHome(!editing)}><SlidersHorizontal size={ICON.md} />{editing ? 'Готово' : 'Настроить главную'}</button>
      {editing && <button className="chip" onClick={() => useUIStore.getState().setActiveView('settings')}>Все настройки</button>}
    </div>
    {childrenArray.map((child, index) => {
      if (!React.isValidElement(child)) return child;
      const props = child.props as { 'data-home-block'?: HomeBlockId; homeBlock?: HomeBlockId };
      const id = props['data-home-block'] ?? props.homeBlock;
      if (!id) return <div key={`other-${index}`} className="home-builder-static" style={{ order: index === 0 ? -1 : 100 }}>{child}</div>;
      const position = layout.homeBlocks.indexOf(id);
      const visiblePosition = visibleBlocks.indexOf(id);
      if (layout.hiddenHomeBlocks.includes(id)) return null;
      return <div key={child.key ?? `${id}-${index}`} className="home-builder-block" style={{ order: position }} data-home-block={id}
        draggable={editing} onDragStart={(e) => e.dataTransfer.setData('text/plain', `home:${id}`)}
        onDragOver={(e) => { if (editing) e.preventDefault(); }} onDrop={(e) => {
          e.preventDefault(); const item = e.dataTransfer.getData('text/plain');
          if (editing && item.startsWith('home:')) move(platform, 'homeBlocks', item.slice(5), position);
        }}>
        {editing && <div className="home-block-tools"><GripVertical size={ICON.md} /><span>{HOME_BLOCK_LABELS[id]}</span>
          <button aria-label={`${HOME_BLOCK_LABELS[id]}: выше`} disabled={visiblePosition === 0} onClick={() => move(platform, 'homeBlocks', id, layout.homeBlocks.indexOf(visibleBlocks[visiblePosition - 1]))}><ArrowUp size={ICON.md} /></button>
          <button aria-label={`${HOME_BLOCK_LABELS[id]}: ниже`} disabled={visiblePosition === visibleBlocks.length - 1} onClick={() => move(platform, 'homeBlocks', id, layout.homeBlocks.indexOf(visibleBlocks[visiblePosition + 1]))}><ArrowDown size={ICON.md} /></button>
          <button aria-label={`Скрыть: ${HOME_BLOCK_LABELS[id]}`} onClick={() => toggle(platform, 'hiddenHomeBlocks', id)}><EyeOff size={ICON.md} /></button>
        </div>}{child}
      </div>;
    })}
  </div>;
};
