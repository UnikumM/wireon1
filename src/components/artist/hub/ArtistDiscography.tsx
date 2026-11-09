import React from 'react';
import { Disc, Play } from 'lucide-react';
import { ArtistAlbum } from '../../../services/artistService';
import { pluralize } from '../../../utils/plural';
import { ICON } from '../../../styles/icons';

interface ArtistDiscographyProps {
  albums: ArtistAlbum[];
  onOpenAlbum: (album: ArtistAlbum) => void;
}

/** Сетка обложек. Секции нет вовсе, когда альбомов не нашлось. */
export const ArtistDiscography: React.FC<ArtistDiscographyProps> = ({ albums, onOpenAlbum }) => {
  if (albums.length === 0) return null;

  return (
    <section aria-labelledby="artist-discography-heading" data-testid="artist-discography-section">
      <h2
        id="artist-discography-heading"
        className="text-xl weight-semibold text-primary row gap-2" style={{ margin: '0 0 var(--space-4) 0' }}
      >
        <Disc size={ICON.lg} className="text-secondary" aria-hidden="true" />
        Дискография
      </h2>

      <div
        className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
      >
        {albums.map((album, index) => (
          <button
            key={album.id}
            type="button"
            onClick={() => onOpenAlbum(album)}
            aria-label={`Открыть альбом «${album.title}»`}
            className="card-interactive card-reset press animate-settle hover-sheen"
            style={
              {
                // Номер обложки в сетке — её задержка: дискография
                // выкладывается по очереди, а не вспыхивает целиком.
                '--stagger': index,
                padding: 'var(--space-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                borderRadius: 'var(--radius-md)',
                // Кнопка, а не `div`: альбом открывается нажатием, и до
                // клавиатуры он тоже должен доходить. Раньше здесь стоял
                // `cursor: default` — честный признак того, что карточка
                // не делала ничего.
                textAlign: 'left',
                // Фон здесь не задаётся нарочно: он живёт в
                // `.card-interactive`, и инлайновое свойство глушило бы
                // `:hover` (DESIGN_SYSTEM §15). Родной вид кнопки
                // сбрасывает `.card-reset` в таблице стилей.
                cursor: 'pointer'
              } as React.CSSProperties
            }
            data-testid={`artist-album-${album.id}`}
          >
            <div
              className="relative w-full radius-sm overflow-hidden row justify-center bg-surface-3 border-subtle" style={{ aspectRatio: '1/1' }}
            >
              {album.coverUrl ? (
                <img
                  src={album.coverUrl}
                  alt={album.title}
                  loading="lazy"
                  className="fill-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <Disc size={ICON.display} className="text-faint" />
              )}
              {/* Знак того, что на обложку можно нажать. Без него карточка
                  выглядит ровно так же, как когда она ничего не делала. */}
              <span
                aria-hidden="true"
                style={{ position: 'absolute', inset: 0, backgroundColor: 'var(--scrim)', color: 'var(--text-on-accent)', transition: 'opacity var(--dur-fast) var(--ease-out)' }}
                className="album-play-veil row justify-center"
              >
                <Play size={ICON.xl} fill="currentColor" />
              </span>
            </div>

            <div className="stack gap-px min-0">
              <span
                className="text-truncate text-sm weight-semibold text-primary"
              >
                {album.title}
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  // Та же беда, что у заголовка популярных треков, только в
                  // карточке альбома: без зазора год и число треков сходятся вплотную.
                  gap: 'var(--space-2)',
                  fontSize: 'var(--text-xs)',
                  color: 'var(--text-muted)'
                }}
              >
                <span className="nowrap">{album.year || 'Релиз'}</span>
                {album.trackCount !== undefined && (
                  <span className="nowrap">
                    {pluralize(album.trackCount, 'трек', 'трека', 'треков')}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
};
