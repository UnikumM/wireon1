/**
 * Core domain types for Wireon
 */

export type AudioSource = 'youtube' | 'soundcloud';

export interface UnifiedTrack {
  id: string; // Unique prefixed ID: "yt_<videoId>" | "sc_<trackId>"
  source: AudioSource;
  originalId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number; // in seconds
  durationFormatted?: string; // "MM:SS"
  artworkUrl: string;
  sourceUrl?: string;
  streamUrl?: string;
  streamExpiry?: number; // epoch timestamp in ms
  bitrate?: number; // kbps
  format?: 'm4a' | 'opus' | 'mp3' | 'hls' | string;
  isPreview?: boolean; // the resolved stream is a snipped preview, not the full track
  addedAt?: number; // epoch timestamp in ms
}

export type PlaybackState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error';

export type RepeatMode = 'off' | 'all' | 'one';

export interface EqSettings {
  bass: number; // dB, -12..+12 (lowshelf ~120 Hz)
  mid: number; // dB, -12..+12 (peaking ~1 kHz)
  treble: number; // dB, -12..+12 (highshelf ~6 kHz)
}

export interface PlaybackSettingsState {
  crossfadeEnabled: boolean;
  crossfadeDuration: number;
  loudnessNormalization: boolean;
}

export interface QueueItem {
  track: UnifiedTrack;
  queueId: string; // unique instance id in queue
  addedAt: number;
  isUserPriority: boolean;
}

export interface Playlist {
  id: string;
  title: string;
  description?: string;
  coverUrl?: string;
  coverGradient?: string;
  tracks: UnifiedTrack[];
  createdAt: number;
  updatedAt: number;
  isSynced: boolean;
}

export interface UserProfile {
  id: string;
  username: string;
  discriminator?: string;
  avatarUrl: string;
  bannerUrl?: string;
  email?: string;
  provider: 'discord' | 'guest';
  status: 'online' | 'idle' | 'dnd' | 'offline';
  accessToken?: string;
  expiresAt?: number;
}
