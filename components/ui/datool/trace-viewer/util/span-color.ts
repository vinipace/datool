import styles from '../trace-viewer.module.css';
import type { SpanNode } from '../types';

export const getSpanColorClassName = (node: SpanNode): string => {
  if (node.isVercel) return String(styles.colorVercel);
  return String(styles[`color${node.resourceIndex % 5}` as 'color0']);
};
