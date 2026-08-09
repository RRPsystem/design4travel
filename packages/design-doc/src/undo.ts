import type { DesignDoc } from './schema.js';

export type UndoStack = {
  past: DesignDoc[];
  future: DesignDoc[];
};

export function emptyStack(): UndoStack {
  return { past: [], future: [] };
}

const MAX_HISTORY = 50;

export function pushSnapshot(stack: UndoStack, snapshot: DesignDoc): UndoStack {
  const past = [...stack.past, snapshot];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, future: [] };
}

export function undo(
  stack: UndoStack,
  current: DesignDoc,
): { doc: DesignDoc; stack: UndoStack } | null {
  if (stack.past.length === 0) return null;
  const past = stack.past.slice();
  const doc = past.pop() as DesignDoc;
  return {
    doc,
    stack: { past, future: [current, ...stack.future] },
  };
}

export function redo(
  stack: UndoStack,
  current: DesignDoc,
): { doc: DesignDoc; stack: UndoStack } | null {
  if (stack.future.length === 0) return null;
  const [doc, ...rest] = stack.future;
  if (!doc) return null;
  return {
    doc,
    stack: { past: [...stack.past, current], future: rest },
  };
}
