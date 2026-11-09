/*
 * Тонкий реэкспорт: карточка разрезана на части в `./trackCard/`, а старый
 * адрес оставлен, чтобы семь экранов и тесты не меняли импорты.
 */
export { TrackCard } from './trackCard/TrackCard';
export type { TrackCardProps } from './trackCard/types';
