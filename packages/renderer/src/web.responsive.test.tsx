import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SCHEMA_VERSION, type DesignDoc, type NodeInstance } from '@design4/design-doc';
import { createDefaultRegistry } from '@design4/typed-nodes';
import { RESPONSIVE_ROOT_CSS, responsiveFontSize } from './targets/web.js';
import { renderTarget } from './render.js';

function docWith(root: NodeInstance): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'd',
    project: { documentType: 'website', title: 'x' },
    meta: { createdAt: 't', updatedAt: 't' },
    outputs: { web: { enabled: true } },
    pages: [{ id: 'p', root }],
  };
}

function render(root: NodeInstance): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderTarget('web', docWith(root), {
      registry: createDefaultRegistry(),
      dataModel: {},
    }) as never,
  );
}

describe('web renderer — responsive rules', () => {
  it('emits the global responsive style block at the root', () => {
    const html = render({
      id: 'root',
      type: 'layout-column',
      props: { padding: 0 },
      children: [{ id: 'h', type: 'heading', props: { text: 'x', level: 2 } }],
    });
    expect(html).toContain('data-design4-responsive');
    expect(html).toContain('box-sizing: border-box');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('max-width: 100%');
    expect(html).toContain('overflow-x: hidden');
  });

  it('hero title uses clamp() with the user-set fontSize as the desktop max', () => {
    const html = render({
      id: 'root',
      type: 'hero',
      props: {
        title: 'Ontdek jouw volgende reis',
        subtitle: 's',
        imageSrc: 'https://example.com/x.jpg',
        titleFontSize: 66,
        height: 520,
        overlay: true,
        align: 'center',
        titleColor: '#fff',
        subtitleColor: '#fff',
      },
    });
    // Desktop max preserved exactly (66px in the clamp upper bound)
    expect(html).toContain('clamp(2rem, 10vw, 66px)');
  });

  it('preserves an alternative user-set desktop hero size (100px)', () => {
    const html = render({
      id: 'root',
      type: 'hero',
      props: {
        title: 'x',
        subtitle: 's',
        imageSrc: 'https://example.com/x.jpg',
        titleFontSize: 100,
        height: 520,
        overlay: true,
        align: 'center',
        titleColor: '#fff',
        subtitleColor: '#fff',
      },
    });
    expect(html).toContain('clamp(2rem, 10vw, 100px)');
    expect(html).not.toContain('clamp(2rem, 10vw, 66px)');
  });

  it('layout-row and layout-column set min-width:0 and max-width:100%', () => {
    const html = render({
      id: 'root',
      type: 'layout-column',
      props: { padding: 0, maxWidth: 1200 },
      children: [
        {
          id: 'row',
          type: 'layout-row',
          props: { padding: 0 },
          children: [{ id: 't', type: 'text', props: { text: 'x' } }],
        },
      ],
    });
    // Column caps itself at min(userMax, 100%) so it never overflows the viewport
    expect(html).toContain('min(1200px, 100%)');
    expect(html).toContain('min-width:0');
  });

  it('hero inner uses clamp() for horizontal padding (mobile-friendly)', () => {
    const html = render({
      id: 'root',
      type: 'hero',
      props: {
        title: 'x',
        subtitle: 's',
        imageSrc: 'https://example.com/x.jpg',
        height: 520,
        overlay: true,
        align: 'center',
        titleColor: '#fff',
        subtitleColor: '#fff',
        titleFontSize: 56,
      },
    });
    expect(html).toContain('clamp(1rem, 4vw, 3rem)');
  });

  it('large headings get a clamp() with user-set desktop size preserved as max', () => {
    // level 1 always scales; the user's 72 is the upper bound
    const html = render({
      id: 'root',
      type: 'heading',
      props: { text: 'Groot', level: 1, fontSize: 72 },
    });
    expect(html).toMatch(/clamp\(\d+px, \d+vw, 72px\)/);
  });

  it('small headings do not get a clamp (no visual noise on already-small text)', () => {
    // level 4 default 20px < 28 threshold; should stay static
    const html = render({
      id: 'root',
      type: 'heading',
      props: { text: 'Klein', level: 4 },
    });
    expect(html).not.toMatch(/clamp\(/);
  });

  it('responsiveFontSize(): scales large sizes, preserves small ones', () => {
    expect(responsiveFontSize(66, 1)).toBe('clamp(24px, 8vw, 66px)');
    expect(responsiveFontSize(48, 1)).toBe('clamp(24px, 8vw, 48px)');
    expect(responsiveFontSize(32, 2)).toBe('clamp(24px, 6vw, 32px)');
    expect(responsiveFontSize(20, 4)).toBe(20); // static
    expect(responsiveFontSize(16)).toBe(16); // static
  });

  it('responsiveFontSize(): min never exceeds the requested size (small headings)', () => {
    // If user picks 22 for a level-1, min should be 22 (not 24 which would exceed it)
    expect(responsiveFontSize(22, 1)).toBe('clamp(22px, 8vw, 22px)');
  });

  it('emits max-width:100% and height:auto for images via global CSS', () => {
    // Verified indirectly: the global CSS block contains the img rule
    expect(RESPONSIVE_ROOT_CSS).toMatch(/img\s*\{[^}]*max-width:\s*100%[^}]*\}/);
    expect(RESPONSIVE_ROOT_CSS).toMatch(/img\s*\{[^}]*height:\s*auto[^}]*\}/);
  });
});
