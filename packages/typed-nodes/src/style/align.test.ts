import { describe, expect, it } from 'vitest';
import { TextAlignSchema } from './align.js';

describe('TextAlignSchema', () => {
  it('accepts canonical values as-is', () => {
    expect(TextAlignSchema.parse('left')).toBe('left');
    expect(TextAlignSchema.parse('center')).toBe('center');
    expect(TextAlignSchema.parse('right')).toBe('right');
  });

  it('normalizes flexbox-synoniemen naar canonical text-align', () => {
    // start → left (AI-verwarring: layout-column heeft align='start')
    expect(TextAlignSchema.parse('start')).toBe('left');
    // end → right (idem)
    expect(TextAlignSchema.parse('end')).toBe('right');
  });

  it('rejects genuinely invalid values', () => {
    expect(() => TextAlignSchema.parse('middle')).toThrow();
    expect(() => TextAlignSchema.parse('stretch')).toThrow();
    expect(() => TextAlignSchema.parse('')).toThrow();
    expect(() => TextAlignSchema.parse(42)).toThrow();
  });

  it('works with .default() as canonical fallback', () => {
    const schemaWithDefault = TextAlignSchema.default('center');
    expect(schemaWithDefault.parse(undefined)).toBe('center');
    // Default doesn't bypass preprocess for defined inputs.
    expect(schemaWithDefault.parse('start')).toBe('left');
  });
});
