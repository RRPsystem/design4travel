import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { createDefaultRegistry } from '@design4/typed-nodes';
import { NotImplementedError, renderTarget } from './index.js';

function makeDoc(): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'd',
    project: { documentType: 'website', title: 'x' },
    meta: { createdAt: 't', updatedAt: 't' },
    outputs: { web: { enabled: true } },
    pages: [{ id: 'p', root: { id: 'r', type: 'heading', props: { text: 'Hi', level: 1 } } }],
  };
}

describe('renderTarget', () => {
  it('renders the web target without throwing', () => {
    const doc = makeDoc();
    const node = renderTarget('web', doc, {
      registry: createDefaultRegistry(),
      dataModel: {},
    });
    expect(node).toBeTruthy();
  });

  it('throws NotImplementedError for unimplemented outputs', () => {
    const doc = makeDoc();
    expect(() =>
      renderTarget('pdf', doc, { registry: createDefaultRegistry(), dataModel: {} }),
    ).toThrow(NotImplementedError);
  });
});
