import React from 'react';
import { Info, ChevronDown, ChevronUp } from 'lucide-react';
import { ArtistProfile } from '../../../services/artistService';
import { Button } from '../../common/Button';
import { ICON } from '../../../styles/icons';

/** Подпись об источнике биографии — чтобы слушатель знал, кто её написал. */
const BIO_SOURCE_LABELS: Record<NonNullable<ArtistProfile['bioSource']>, string> = {
  'wikipedia-ru': 'Источник: Википедия',
  'wikipedia-en': 'Источник: Wikipedia (англ.)',
  'youtube-music': 'Источник: описание на YouTube Music'
};

/** Длиннее этого — показываем начало и кнопку «Читать полностью». */
const BIO_PREVIEW_LENGTH = 280;

interface ArtistBioProps {
  bio: string | undefined;
  bioSource: ArtistProfile['bioSource'];
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Биография. Показывается только настоящая: старая заглушка «Official artist
 * profile for X.» заполняла секцию предложением, которого никто не писал.
 * Без текста секции нет вовсе.
 */
export const ArtistBio: React.FC<ArtistBioProps> = ({ bio: rawBio, bioSource, expanded, onToggle }) => {
  const bio = rawBio?.trim() ?? '';
  if (bio.length === 0) return null;

  const isBioLong = bio.length > BIO_PREVIEW_LENGTH;
  const displayedBio = expanded || !isBioLong ? bio : `${bio.slice(0, BIO_PREVIEW_LENGTH)}…`;

  return (
    <section
      aria-labelledby="artist-bio-heading"
      className="panel radius-lg stack gap-3 p-6 bg-surface-1 border-subtle"
      data-testid="artist-bio-section"
    >
      <h2
        id="artist-bio-heading"
        className="m-0 text-lg weight-semibold text-primary row gap-2"
      >
        <Info size={ICON.md} className="text-secondary" aria-hidden="true" />
        Об исполнителе
      </h2>

      <p
        className="m-0 text-sm text-secondary" style={{ lineHeight: 'var(--leading-relaxed, 1.6)', whiteSpace: 'pre-line' }}
        data-testid="artist-bio-text"
      >
        {displayedBio}
      </p>

      {bioSource && (
        <span
          className="text-xs text-faint"
          data-testid="artist-bio-source"
        >
          {BIO_SOURCE_LABELS[bioSource]}
        </span>
      )}

      {isBioLong && (
        <Button
          variant="ghost"
          size="sm"
          icon={expanded ? <ChevronUp size={ICON.sm} /> : <ChevronDown size={ICON.sm} />}
          onClick={onToggle}
          style={{ alignSelf: 'flex-start', marginTop: 'var(--space-1)' }}
          data-testid="artist-bio-toggle-btn"
        >
          {expanded ? 'Свернуть' : 'Читать полностью'}
        </Button>
      )}
    </section>
  );
};
