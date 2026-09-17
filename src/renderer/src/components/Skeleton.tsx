import type { CSSProperties, ReactElement } from 'react';
import s from './feedback.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: string;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 10, radius, style }: SkeletonProps): ReactElement {
  return <span className={s.skeleton} aria-hidden="true" style={{ display: 'block', width, height, borderRadius: radius, ...style }} />;
}
