import type { PlatformType } from '../../../services/playlistImporter';

export interface PlatformBadgeConfig {
  name: string;
  color: string;
  bg: string;
  border: string;
}

/**
 * Метка площадки берётся из темы, а не из фирменной палитры сервиса.
 *
 * Раньше здесь стояли фирменные цвета литералами — единственное место в
 * приложении, красившееся мимо темы. На светлых темах чистый `#FF0033` на белом
 * оказывался единственным кричащим пятном в окне. Приглушённые до нашей пастели
 * пары `--badge-*` уже описаны в theme.css и имеют светлый вариант.
 */
function badge(name: string, token: string): PlatformBadgeConfig {
  return {
    name,
    color: `var(--badge-${token}-text)`,
    bg: `var(--badge-${token}-bg)`,
    border: `var(--badge-${token}-border)`
  };
}

/** Метки площадок в окне импорта. Цвета — из темы, см. `badge` выше. */
export const PLATFORM_CONFIG: Record<PlatformType, PlatformBadgeConfig> = {
  youtube: badge('YouTube Music', 'youtube'),
  soundcloud: badge('SoundCloud', 'soundcloud'),
  spotify: badge('Spotify', 'spotify'),
  yandex: badge('Yandex Music', 'yandex'),
  vk: badge('VK Music', 'vk'),
  apple: badge('Apple Music', 'apple')
};

/** Площадки, которые перечислены плашками под полем ссылки. */
export const LINK_PLATFORMS: PlatformType[] = ['spotify', 'yandex', 'vk', 'apple'];
