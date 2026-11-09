import React from 'react';
import { PlayerBar } from './PlayerBar';
import { FullscreenPlayer } from './FullscreenPlayer';
import { PlayerIsland } from './PlayerIsland';
import { PlayerStage } from './PlayerStage';

export type PlayerShell = 'desktop' | 'mobile';

export interface PlayerBodyProps {
  /** Какая оболочка держит плеер: от неё зависит тело, а не поведение. */
  shell: PlayerShell;
}

/**
 * Один плеер в трёх телах.
 *
 *   `Player.Bar`   — то, что стоит на экране всегда: полоса на ПК, островок на телефоне;
 *   `Player.Stage` — то, что раскрывается поверх: окно на ПК, сцена на телефоне;
 *   мини-окно на ПК — отдельное окно Electron, оно собирается из тех же частей
 *   (`core/`) в `mini/MiniWindow.tsx`.
 *
 * Общие части — обложка с одним `layoutId`, заголовки, свет от обложки, хуки
 * транспорта и избранного — лежат в `core/`. Тела различаются раскладкой и тем,
 * что показывают, а не тем, как работают.
 */
const Bar: React.FC<PlayerBodyProps> = ({ shell }) => (shell === 'mobile' ? <PlayerIsland /> : <PlayerBar />);
const Stage: React.FC<PlayerBodyProps> = ({ shell }) => (shell === 'mobile' ? <PlayerStage /> : <FullscreenPlayer />);

export const Player = { Bar, Stage };
