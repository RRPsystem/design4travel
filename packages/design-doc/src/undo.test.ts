import { describe, expect, it } from 'vitest';
import { emptyStack, pushSnapshot, undo, redo } from './undo.js';
import { SCHEMA_VERSION, type DesignDoc } from './schema.js';

function doc(name: string): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'd',
    project: { documentType: 'website', title: name },
    meta: { createdAt: 't', updatedAt: 't' },
    outputs: { web: { enabled: true } },
    pages: [{ id: 'p', root: { id: 'r', type: 'text', props: {} } }],
  };
}

describe('undo/redo', () => {
  it('undo returns null when empty', () => {
    expect(undo(emptyStack(), doc('a'))).toBeNull();
  });

  it('push then undo restores the previous snapshot', () => {
    const a = doc('a');
    const b = doc('b');
    const stack = pushSnapshot(emptyStack(), a);
    const res = undo(stack, b);
    expect(res).not.toBeNull();
    expect(res!.doc.project.title).toBe('a');
    expect(res!.stack.past).toHaveLength(0);
    expect(res!.stack.future).toHaveLength(1);
  });

  it('redo restores the undone snapshot', () => {
    const a = doc('a');
    const b = doc('b');
    const stack = pushSnapshot(emptyStack(), a);
    const undone = undo(stack, b)!;
    const redone = redo(undone.stack, undone.doc)!;
    expect(redone.doc.project.title).toBe('b');
    expect(redone.stack.past).toHaveLength(1);
    expect(redone.stack.future).toHaveLength(0);
  });
});
