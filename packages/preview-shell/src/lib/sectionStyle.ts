/**
 * mergeSectionRoot stub voor preview-shell.
 * Design4-componenten die brand-override styling ondersteunen kunnen
 *   `import { mergeSectionRoot } from '../../lib/sectionStyle';`
 * gebruiken; in de sandbox merged het niets en returnt gewoon de defaults.
 */

export interface ResolvedSectionStyle {
  className?: string;
  style?: React.CSSProperties;
}

export function mergeSectionRoot(
  _override: unknown,
  base: { className?: string; style?: React.CSSProperties },
): { className?: string; style?: React.CSSProperties } {
  return base;
}
