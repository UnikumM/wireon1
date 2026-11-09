import React from 'react';
import { Users, RefreshCw, User } from 'lucide-react';
import { SimilarArtistOrigin, SimilarArtistsResult } from '../../../services/similarArtists';
import { Button } from '../../common/Button';
import { Skeleton } from '../../common/Skeleton';
import { EmptyState } from '../../common/EmptyState';
import { ICON } from '../../../styles/icons';

/**
 * Подпись под карточкой похожего: связь называется своим именем, чтобы человек
 * понимал, почему ему это показали, и не считал подбор случайным.
 */
const SIMILAR_ORIGIN_LABELS: Record<SimilarArtistOrigin, string> = {
  'youtube-music': 'По версии YouTube Music',
  collab: 'Записывались вместе',
  library: 'Рядом в вашей медиатеке',
  related: 'В рекомендациях к трекам',
  search: 'Рядом в поиске'
};

// Одна сетка на скелет и на карточки: заглушки должны стоять там же, где
// потом встанут похожие, иначе блок дёргается при подстановке.
const similarGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
  gap: 'var(--space-4)'
};

interface ArtistSimilarProps {
  artistName: string;
  /** `null`, пока подбор идёт. */
  similar: SimilarArtistsResult | null;
  onRetry: () => void;
  onOpenArtist: (name: string) => void;
}

/**
 * Похожие исполнители. Секция рисуется всегда, когда профиль открыт: раньше она
 * висела на условии `similarArtists.length > 0` и при пустом списке исчезала
 * целиком, а список пуст почти всегда — карусель YouTube Music из renderer
 * недостижима (см. `services/similarArtists.ts`). Молча пропавший блок человек
 * читает как поломку, поэтому у него есть скелет, ответ и внятное объяснение
 * пустоты.
 */
export const ArtistSimilar: React.FC<ArtistSimilarProps> = ({
  artistName,
  similar,
  onRetry,
  onOpenArtist
}) => (
  <section aria-labelledby="artist-similar-heading" data-testid="artist-similar-section">
    <h2
      id="artist-similar-heading"
      className="text-xl weight-semibold text-primary row gap-2" style={{ margin: '0 0 var(--space-4) 0' }}
    >
      <Users size={ICON.lg} className="text-secondary" aria-hidden="true" />
      Похожие исполнители
    </h2>

    {!similar ? (
      <div style={similarGridStyle} data-testid="artist-similar-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} width="100%" height="164px" radius="var(--radius-md)" />
        ))}
      </div>
    ) : similar.artists.length === 0 ? (
      <EmptyState
        icon={<Users size={ICON.display} />}
        title={
          similar.status === 'unavailable'
            ? 'Похожих сейчас не подобрать'
            : 'Похожих исполнителей не нашлось'
        }
        description={
          similar.status === 'unavailable'
            ? `Ни YouTube, ни ваша медиатека сейчас не отвечают. Похожие на «${artistName}» появятся, когда связь вернётся.`
            : `Мы посмотрели совместные треки, рекомендации YouTube и вашу медиатеку — рядом с «${artistName}» никого не набралось. Послушайте его в «Радио», и связи появятся.`
        }
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={ICON.sm} />}
            onClick={onRetry}
            data-testid="artist-similar-retry-btn"
          >
            Повторить
          </Button>
        }
        style={{ padding: 'var(--space-6)' }}
        data-testid="artist-similar-empty"
      />
    ) : (
      <div style={similarGridStyle}>
        {similar.artists.map((item, idx) => (
          <button
            type="button"
            key={item.name}
            onClick={() => onOpenArtist(item.name)}
            className="card-interactive press focus-ring animate-settle hover-sheen"
            style={
              {
                '--stagger': idx,
                padding: 'var(--space-4) var(--space-2)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
                cursor: 'pointer',
                textAlign: 'center'
              } as React.CSSProperties
            }
            data-testid={`similar-artist-card-${idx}`}
          >
            <div
              className="radius-full overflow-hidden row justify-center bg-surface-3" style={{ width: '80px', height: '80px', border: '2px solid var(--border-accent)' }}
            >
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={item.name}
                  loading="lazy"
                  className="fill-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <User size={ICON.display} className="text-faint" />
              )}
            </div>
            <span
              className="text-truncate w-full text-sm weight-medium text-primary"
            >
              {item.name}
            </span>
            <span
              className="text-truncate w-full text-xs text-muted"
              data-testid={`similar-artist-reason-${idx}`}
            >
              {SIMILAR_ORIGIN_LABELS[item.origin]}
            </span>
          </button>
        ))}
      </div>
    )}
  </section>
);
