import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '../setup';
import { QualityBadge } from '../../src/components/search/trackCard/TrackBadges';
import { clearQuality, markLowBitrate, markPreview, resetTrackQualityForTests } from '../../src/services/trackQuality';

/** Бейдж качества в списке: появляется по пометке и исчезает, когда её сняли. */

beforeEach(() => {
  resetTrackQualityForTests();
});

describe('QualityBadge', () => {
  it('без пометки не рисуется', () => {
    render(<QualityBadge trackId="sc_1" variant="row" />);
    expect(screen.queryByTestId('row-quality-badge-sc_1')).not.toBeInTheDocument();
  });

  it('показывает «отрывок» и «низкое качество» и следит за картой', () => {
    markPreview('sc_1');
    render(<QualityBadge trackId="sc_1" variant="row" />);
    const badge = screen.getByTestId('row-quality-badge-sc_1');
    expect(badge).toHaveTextContent('отрывок');
    expect(badge).toHaveAttribute('title', expect.stringMatching(/30-секундный/));

    act(() => {
      clearQuality('sc_1');
      markLowBitrate('sc_1');
    });
    expect(screen.getByTestId('row-quality-badge-sc_1')).toHaveTextContent('низкое качество');

    act(() => {
      clearQuality('sc_1');
    });
    expect(screen.queryByTestId('row-quality-badge-sc_1')).not.toBeInTheDocument();
  });

  it('в карточке — свой testid', () => {
    markPreview('sc_2');
    render(<QualityBadge trackId="sc_2" variant="card" />);
    expect(screen.getByTestId('card-quality-badge-sc_2')).toBeInTheDocument();
  });
});
