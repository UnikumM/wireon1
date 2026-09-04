export type VisualizerPreset = 
  | 'CYBER_BARS' 
  | 'HOLOGRAPHIC_WAVE' 
  | 'CIRCULAR_SPECTRUM' 
  | 'AMBIENT_AURORA';

export interface VisualizerConfig {
  preset: VisualizerPreset;
  fftSize: number;
  smoothingTimeConstant: number;
  barCount: number;
  colorScheme: 'cyan-violet' | 'emerald-cyan' | 'neon-rainbow' | 'monochrome';
}
