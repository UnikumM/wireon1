import React from 'react';
import { usePrefersReducedMotion } from '../../hooks';
import { useTextOverflow } from './playerHooks';

export interface MarqueeTextProps {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  'data-testid'?: string;
}

/**
 * Truncates by default and only scrolls when the text genuinely does not fit —
 * and never when the user asked for reduced motion. The duplicate copy is what
 * makes the `.marquee` loop seamless.
 */
export const MarqueeText: React.FC<MarqueeTextProps> = ({
  text,
  className = '',
  style,
  'data-testid': testId
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const { ref, overflows } = useTextOverflow(text);
  const scrolls = overflows && !reducedMotion;

  return (
    <span
      ref={ref}
      // `marquee-line` обязателен обеим ветвям, и это не украшение. Элемент
      // здесь — `span`, а у строчного элемента `overflow` и `text-overflow`
      // не работают по устройству CSS: `.text-truncate` на нём не обрезает
      // ничего, и длинное название уезжает за полосу плеера под кнопки
      // управления. Класс делает его блоком, и обрезка начинает работать.
      className={`marquee-line ${scrolls ? 'marquee' : 'text-truncate'}${className ? ` ${className}` : ''}`}
      style={style}
      title={text}
      data-testid={testId}
    >
      {scrolls ? (
        <>
          <span>{text}</span>
          <span aria-hidden="true">{text}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
};
