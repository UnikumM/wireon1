/**
 * Окно «Теги и заметка» (идея 13 плана 4.0): чипы тегов, ввод с подсказками,
 * заметка, удаление; пункт меню на ПК и в листе действий на телефоне; бейджи
 * на карточке.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../setup';
import { TrackNotesModal, TrackNotesModalHost } from '../../src/components/modals/TrackNotesModal';
import { TagBadges } from '../../src/components/search/trackCard/TrackBadges';
import { TrackActionsSheet } from '../../src/components/mobile/TrackActionsSheet';
import { TrackCard } from '../../src/components/search/TrackCard';
import { useUIStore } from '../../src/store/useUIStore';
import { db } from '../../src/services/db';
import { getNote, getTags, resetTrackNotesForTests, setTags } from '../../src/services/trackNotes';
import { resetLibraryStore, resetPlayerStore, resetUIStore, signInForTests } from '../helpers/testUtils';
import type { UnifiedTrack } from '../../src/types/music';

const track: UnifiedTrack = {
  id: 'yt_run',
  source: 'youtube',
  originalId: 'run',
  title: 'Беговая',
  artist: 'Кто-то',
  duration: 200,
  artworkUrl: ''
};

describe('TrackNotesModal', () => {
  beforeEach(async () => {
    resetTrackNotesForTests();
    await db.trackNotes.clear();
    resetUIStore();
    resetLibraryStore();
    resetPlayerStore();
    signInForTests();
    useUIStore.setState({ notesTrack: null, actionsTrack: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Enter и запятая добавляют теги, крестик убирает, подсказки — из чужих тегов', async () => {
    await setTags('yt_other', ['вечер', 'бег']);
    const onClose = vi.fn();
    render(<TrackNotesModal track={track} onClose={onClose} />);

    expect(screen.getByText('Теги и заметка')).toBeInTheDocument();
    expect(screen.getByText('Беговая — Кто-то')).toBeInTheDocument();
    expect(screen.queryByTestId('track-notes-tags')).not.toBeInTheDocument();

    const input = screen.getByTestId('track-notes-tag-input');
    fireEvent.change(input, { target: { value: ' #Для бега ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('track-notes-tag-для бега')).toHaveTextContent('Для бега'));
    expect(getTags('yt_run')).toEqual(['Для бега']);
    expect(input).toHaveValue('');

    // Запятая — тоже разделитель; дубль по ключу не добавляется.
    fireEvent.change(input, { target: { value: 'утро,для бега,' } });
    await waitFor(() => expect(getTags('yt_run')).toEqual(['Для бега', 'утро']));
    expect(screen.getByTestId('track-notes-tags').children).toHaveLength(2);

    // Подсказки: теги других треков, которых нет у этого; клик добавляет.
    expect(screen.getByTestId('track-notes-suggest-вечер')).toBeInTheDocument();
    expect(screen.getByTestId('track-notes-suggest-бег')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('track-notes-suggest-бег'));
    await waitFor(() => expect(getTags('yt_run')).toContain('бег'));
    expect(screen.queryByTestId('track-notes-suggest-бег')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('track-notes-tag-remove-утро'));
    await waitFor(() => expect(getTags('yt_run')).toEqual(['Для бега', 'бег']));

    fireEvent.click(screen.getByTestId('modal-close-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  it('заметка сохраняется после паузы и при потере фокуса; пустая вместе с тегами удаляет запись', async () => {
    vi.useFakeTimers();
    try {
      render(<TrackNotesModal track={track} onClose={() => {}} />);
      const note = screen.getByTestId('track-notes-note-input');
      fireEvent.change(note, { target: { value: 'припев в 1:12' } });
      expect(getNote('yt_run')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(getNote('yt_run')?.note).toBe('припев в 1:12');

      fireEvent.change(note, { target: { value: '' } });
      fireEvent.blur(note);
      await act(async () => {});
      expect(getNote('yt_run')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('хост открывается из стора и закрывается в него', () => {
    render(<TrackNotesModalHost />);
    expect(screen.queryByTestId('track-notes-modal')).not.toBeInTheDocument();

    act(() => useUIStore.getState().openTrackNotes(track));
    expect(screen.getByTestId('track-notes-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('modal-close-btn'));
    expect(useUIStore.getState().notesTrack).toBeNull();
  });

  it('пункт меню карточки на ПК открывает окно через стор', () => {
    render(<TrackCard track={track} />);
    fireEvent.click(screen.getByTestId(`track-more-btn-${track.id}`));
    fireEvent.click(screen.getByTestId(`menu-notes-${track.id}`));
    expect(useUIStore.getState().notesTrack?.id).toBe('yt_run');
  });

  it('лист действий на телефоне закрывается и открывает окно', () => {
    const onClose = vi.fn();
    render(<TrackActionsSheet track={track} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('track-actions-notes'));
    expect(onClose).toHaveBeenCalled();
    expect(useUIStore.getState().notesTrack?.id).toBe('yt_run');
  });

  it('бейджи: до двух тегов и «+N», нет тегов — нет разметки', async () => {
    const { container } = render(<TagBadges trackId="yt_run" variant="row" />);
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      await setTags('yt_run', ['бег', 'вечер', 'Диме', 'утро']);
    });
    const badges = screen.getAllByTestId('row-tag-badge-yt_run');
    expect(badges.map((b) => b.textContent)).toEqual(['бег', 'вечер']);
    expect(screen.getByTestId('row-tag-badges-yt_run')).toHaveTextContent('+2');
    expect(screen.getByTestId('row-tag-badges-yt_run')).toHaveAttribute('title', 'Теги: бег, вечер, Диме, утро');
  });
});
