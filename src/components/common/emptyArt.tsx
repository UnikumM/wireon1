import React from 'react';
import { motion } from 'motion/react';
import { appear, EASE, motionDisabled, readDuration, STAGGER_MS } from '../../styles/motion';

/**
 * Иллюстрации пустых экранов — одной линией.
 *
 * Пустой экран — единственное место, где человеку нечего разглядывать, и
 * стоковая картинка там читается как заглушка. Вместо неё — контур в полтора
 * пикселя тем же цветом, что и подпись: он объясняет, что здесь будет, и
 * ничего не обещает. Одна-две линии рисунка помечены акцентом (`accent`) —
 * та деталь, ради которой экран существует: пластинка на полке, пульс в сердце,
 * стрелка в очереди.
 *
 * Цвет — только через классы (`.empty-art`, `.empty-art-accent`): рисунок
 * следует за темой и пресетом, как и текст рядом. Линия дорисовывается
 * (`pathLength` 0 → 1) на `--dur-slow`, штрих за штрихом со сдвигом списка;
 * «меньше движения» схлопывает это так же, как остальные переходы.
 */
export type EmptyArtName =
  | 'library'
  | 'search'
  | 'queue'
  | 'offline'
  | 'favorites'
  | 'history'
  | 'playlists'
  | 'lyrics'
  | 'wave'
  | 'network';

interface Stroke {
  d: string;
  /** Линия, которая несёт смысл рисунка: красится акцентом. */
  accent?: boolean;
}

export const EMPTY_ART_VIEWBOX = '0 0 120 80';

const ART: Record<EmptyArtName, Stroke[]> = {
  // Полка, на которой стоит одна пластинка и прислонён конверт.
  library: [
    { d: 'M12 64 H108' },
    { d: 'M20 64 V72 M100 64 V72' },
    { d: 'M24 64 V36 H36 V64' },
    { d: 'M48 46 a16 16 0 1 0 32 0 a16 16 0 1 0 -32 0', accent: true },
    { d: 'M61 46 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0', accent: true }
  ],
  // Лупа, внутри которой волна звука.
  search: [
    { d: 'M32 36 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0' },
    { d: 'M66 50 L86 70' },
    { d: 'M40 36 c4 -9 8 -9 12 0 s8 9 12 0', accent: true }
  ],
  // Три пустые строки и стрелка «дальше».
  queue: [
    { d: 'M24 24 H80' },
    { d: 'M24 40 H80' },
    { d: 'M24 56 H80' },
    { d: 'M98 22 V58 M90 50 L98 58 L106 50', accent: true }
  ],
  // Облако, перечёркнутое одной чертой.
  offline: [
    { d: 'M36 58 H82 A13 13 0 0 0 84 32 A18 18 0 0 0 50 26 A18 18 0 0 0 36 58 Z' },
    { d: 'M28 20 L96 68', accent: true }
  ],
  // Контур сердца и пульс внутри.
  favorites: [
    { d: 'M60 68 C44 56 22 44 22 28 A16 16 0 0 1 60 22 A16 16 0 0 1 98 28 C98 44 76 56 60 68 Z' },
    { d: 'M36 44 H50 L56 32 L64 56 L70 44 H84', accent: true }
  ],
  // Часы со стрелкой, которая идёт назад.
  history: [
    { d: 'M41 31 A22 22 0 1 0 52.5 21.3' },
    { d: 'M52.5 21.3 L52 13 M52.5 21.3 L60 25' },
    { d: 'M60 30 V42 L69 48', accent: true }
  ],
  // Папка со списком.
  playlists: [
    { d: 'M18 26 H44 L50 32 H102 V64 H18 Z' },
    { d: 'M34 44 H86 M34 54 H70', accent: true }
  ],
  // Две строки текста и микрофон.
  lyrics: [
    { d: 'M18 30 H62 M18 44 H52' },
    { d: 'M94 28 V40 A8 8 0 0 1 78 40 V28 A8 8 0 0 1 94 28 Z', accent: true },
    { d: 'M72 40 a14 14 0 0 0 28 0 M86 54 V64 M78 64 H94' }
  ],
  // Волна и её эхо ниже.
  wave: [
    { d: 'M12 42 C22 22 32 22 42 42 S62 62 72 42 S92 22 108 42', accent: true },
    { d: 'M20 58 C30 50 40 50 50 58 S70 66 80 58 S100 50 108 58' }
  ],
  // Штекер с провисшим проводом.
  network: [
    { d: 'M38 22 V40 M50 22 V40', accent: true },
    { d: 'M30 40 H58 V52 A14 14 0 0 1 30 52 Z' },
    { d: 'M44 66 C44 76 66 78 74 64 C80 54 96 54 104 62' }
  ]
};

/** Есть ли иллюстрация с таким именем. */
export function hasEmptyArt(name: string | undefined): name is EmptyArtName {
  return name !== undefined && Object.prototype.hasOwnProperty.call(ART, name);
}

export interface EmptyArtProps {
  name: EmptyArtName;
  className?: string;
}

/**
 * Рисунок одной линией. Появляется глаголом «появиться», каждый штрих
 * дорисовывается со сдвигом, как строка в списке. Неизвестное имя — ничего не
 * рисуем и не падаем: экран остаётся с заголовком и действием.
 */
export const EmptyArt: React.FC<EmptyArtProps> = ({ name, className = '' }) => {
  const strokes = hasEmptyArt(name) ? ART[name] : null;
  if (!strokes) return null;

  const draw = readDuration('slow') / 1000;
  const still = motionDisabled();

  return (
    <motion.svg
      {...appear()}
      className={`empty-art${className ? ` ${className}` : ''}`}
      viewBox={EMPTY_ART_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-testid="empty-art"
      data-art={name}
    >
      {strokes.map((stroke, index) => (
        <motion.path
          key={stroke.d}
          d={stroke.d}
          className={stroke.accent ? 'empty-art-accent' : undefined}
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{
            duration: draw,
            ease: EASE.out,
            delay: still ? 0 : (index * STAGGER_MS) / 1000
          }}
        />
      ))}
    </motion.svg>
  );
};
