import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../../src/components/common/Modal';
import { Sheet } from '../../src/components/mobile/Sheet';

describe('overlay isolation from scrollable and animated track containers', () => {
  it.each(['modal', 'sheet'] as const)('%s escapes transformed ancestors and consumes clicks', (kind) => {
    const playTrack = vi.fn();
    const onClose = vi.fn();
    const action = vi.fn();
    const content = <button onClick={action}>Choose playlist</button>;
    const { container } = render(
      <div style={{ transform: 'translateY(0)', overflow: 'hidden' }} onClick={playTrack}>
        {kind === 'modal' ? (
          <Modal isOpen onClose={onClose} title="Playlist">{content}</Modal>
        ) : (
          <Sheet isOpen onClose={onClose} title="Playlist" data-testid="picker">{content}</Sheet>
        )}
      </div>
    );

    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Choose playlist' }));
    expect(action).toHaveBeenCalledOnce();
    expect(playTrack).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement!);
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(playTrack).not.toHaveBeenCalled();
  });

  it('keeps native vertical scrolling available throughout the sheet content ancestry', () => {
    render(
      <Sheet isOpen onClose={vi.fn()} title="Playlists" data-testid="picker">
        <button>Last playlist</button>
      </Sheet>
    );
    const content = screen.getByTestId('picker').querySelector('.scrollbar-thin') as HTMLElement;
    expect(content.style.touchAction).toBe('pan-y');
    let ancestor = content.parentElement;
    while (ancestor && ancestor !== document.body) {
      expect(ancestor.style.touchAction).not.toBe('none');
      ancestor = ancestor.parentElement;
    }
    expect(content).toHaveAttribute('data-swipe-ignore');
    expect(content.style.minHeight).toBe('0');
  });
});
