import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { headingNode } from '@design4/typed-nodes';
import { resolveProps } from './resolveProps.js';

function makeDoc(): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'd',
    project: { documentType: 'website', title: 'x' },
    meta: { createdAt: 't', updatedAt: 't' },
    brandTokens: { 'brand.primary': '#0057ff' },
    outputs: { web: { enabled: true } },
    pages: [{ id: 'p', root: { id: 'r', type: 'heading', props: {} } }],
  };
}

describe('resolveProps', () => {
  it('parses via node schema and returns defaults', () => {
    const doc = makeDoc();
    const node = doc.pages[0]!.root;
    const { props, error } = resolveProps(node, 'web', doc, {}, headingNode);
    expect(error).toBeUndefined();
    expect(props.text).toBe('Kop');
    expect(props.level).toBe(2);
  });

  it('applies per-output overrides', () => {
    const doc = makeDoc();
    const node = doc.pages[0]!.root;
    node.props = { text: 'Base', level: 1 };
    node.overrides = { web: { props: { level: 3 } } };
    const { props } = resolveProps(node, 'web', doc, {}, headingNode);
    expect(props.text).toBe('Base');
    expect(props.level).toBe(3);
  });

  it('resolves bind slots from the data model', () => {
    const doc = makeDoc();
    const node = doc.pages[0]!.root;
    node.bind = { text: 'accommodation.name' };
    const { props } = resolveProps(
      node,
      'web',
      doc,
      { accommodation: { name: 'Villa Aurora' } },
      headingNode,
    );
    expect(props.text).toBe('Villa Aurora');
  });

  it('substitutes brand-token references', () => {
    const doc = makeDoc();
    const node = doc.pages[0]!.root;
    node.props = { text: 'Hi', color: '{brand.primary}' };
    const { props } = resolveProps(node, 'web', doc, {}, headingNode);
    expect(props.color).toBe('#0057ff');
  });

  it('falls back to defaults + returns error on invalid props', () => {
    const doc = makeDoc();
    const node = doc.pages[0]!.root;
    node.props = { text: 'Hi', level: 9 }; // invalid level
    const { props, error } = resolveProps(node, 'web', doc, {}, headingNode);
    expect(error).toBeDefined();
    expect(props.level).toBe(2); // schema default
  });
});
