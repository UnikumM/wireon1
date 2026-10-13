import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../setup';
import { ForYouView } from '../../src/components/foryou/ForYouView';
import * as dbService from '../../src/services/db';
import { resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import { UnifiedTrack } from '../../src/types/music';

const track = (n: number): UnifiedTrack => ({
  id: `yt_auto_${n}`,
  source: 'youtube',
  originalId: String(n),
  title: `Auto ${n}`,
  artist: `Artist ${n}`,
  duration: 200,
  artworkUrl: ''
});

describe('3.0: живые подборки в «Для вас»', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetLibraryStore();
    resetUIStore();
  });

  it('показывает «На повторе», когда есть что крутить', async () => {
    const now = Date.now();
    for (let n = 0; n < 6; n++) {
      await dbService.db.history.put({ id: track(n).id, track: track(n), playCount: 3, playedAt: now - 1000 });
      await dbService.db.plays.add({ trackId: track(n).id, playedAt: now - 2 * 86400000 });
      await dbService.db.plays.add({ trackId: track(n).id, playedAt: now - 3 * 86400000 });
    }
    render(<ForYouView />);
    expect(await screen.findByTestId('foryou-auto-mixes')).toBeInTheDocument();
    expect(await screen.findByText('На повторе')).toBeInTheDocument();
  });

  it('без истории раздела нет', async () => {
    render(<ForYouView />);
    await screen.findByTestId('foryou-view');
    expect(screen.queryByTestId('foryou-auto-mixes')).toBeNull();
  });
});
