import { describe, expect, it } from 'vitest';
import { resolveBinding } from './resolve.js';
import { luxuryResort, missingImage } from './mockData.js';

describe('resolveBinding', () => {
  it('resolves nested paths', () => {
    expect(resolveBinding(luxuryResort, 'accommodation.name')).toBe('Villa Aurora');
    expect(resolveBinding(luxuryResort, 'accommodation.price.amount')).toBe(780);
    expect(resolveBinding(luxuryResort, 'accommodation.location.country')).toBe('Italië');
  });

  it('returns undefined for missing segments', () => {
    expect(resolveBinding(missingImage, 'accommodation.mainImage')).toBeUndefined();
    expect(resolveBinding(luxuryResort, 'nope.at.all')).toBeUndefined();
  });

  it('handles null/undefined input safely', () => {
    expect(resolveBinding(null, 'a.b')).toBeUndefined();
    expect(resolveBinding(undefined, 'a.b')).toBeUndefined();
  });
});
