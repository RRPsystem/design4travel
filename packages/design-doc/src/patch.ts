import { produce } from 'immer';
import type { DesignDoc, NodeInstance } from './schema.js';

export type PatchOp =
  | { kind: 'setProp'; nodeId: string; key: string; value: unknown }
  | { kind: 'setProps'; nodeId: string; props: Record<string, unknown> }
  | { kind: 'setBind'; nodeId: string; key: string; path: string | null }
  | { kind: 'reorderChildren'; parentId: string; order: string[] }
  | { kind: 'insertNode'; parentId: string; index: number; node: NodeInstance }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'setBrandToken'; key: string; value: string };

export class PatchError extends Error {
  constructor(
    message: string,
    public readonly op: PatchOp,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

function findNode(
  page: { root: NodeInstance },
  nodeId: string,
): NodeInstance | undefined {
  const stack: NodeInstance[] = [page.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === nodeId) return node;
    if (node.children) stack.push(...node.children);
  }
  return undefined;
}

function findNodeInDoc(doc: DesignDoc, nodeId: string): NodeInstance | undefined {
  for (const page of doc.pages) {
    const found = findNode(page, nodeId);
    if (found) return found;
  }
  return undefined;
}

function findParent(
  doc: DesignDoc,
  nodeId: string,
): { parent: NodeInstance; index: number } | undefined {
  const visit = (node: NodeInstance): { parent: NodeInstance; index: number } | undefined => {
    if (!node.children) return undefined;
    const index = node.children.findIndex((c) => c.id === nodeId);
    if (index >= 0) return { parent: node, index };
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  for (const page of doc.pages) {
    const found = visit(page.root);
    if (found) return found;
  }
  return undefined;
}

export function applyPatch(doc: DesignDoc, op: PatchOp): DesignDoc {
  return produce(doc, (draft) => {
    switch (op.kind) {
      case 'setProp': {
        const node = findNodeInDoc(draft, op.nodeId);
        if (!node) throw new PatchError(`Node not found: ${op.nodeId}`, op);
        node.props[op.key] = op.value;
        break;
      }
      case 'setProps': {
        const node = findNodeInDoc(draft, op.nodeId);
        if (!node) throw new PatchError(`Node not found: ${op.nodeId}`, op);
        node.props = { ...node.props, ...op.props };
        break;
      }
      case 'setBind': {
        const node = findNodeInDoc(draft, op.nodeId);
        if (!node) throw new PatchError(`Node not found: ${op.nodeId}`, op);
        if (op.path === null) {
          if (node.bind) delete node.bind[op.key];
        } else {
          node.bind = { ...(node.bind ?? {}), [op.key]: op.path };
        }
        break;
      }
      case 'reorderChildren': {
        const parent = findNodeInDoc(draft, op.parentId);
        if (!parent) throw new PatchError(`Parent not found: ${op.parentId}`, op);
        if (!parent.children) throw new PatchError(`Parent has no children`, op);
        const map = new Map(parent.children.map((c) => [c.id, c]));
        const next = op.order.map((id) => map.get(id));
        if (next.some((n) => !n) || next.length !== parent.children.length) {
          throw new PatchError(`reorderChildren order mismatch`, op);
        }
        parent.children = next as NodeInstance[];
        break;
      }
      case 'insertNode': {
        const parent = findNodeInDoc(draft, op.parentId);
        if (!parent) throw new PatchError(`Parent not found: ${op.parentId}`, op);
        if (!parent.children) parent.children = [];
        const clamped = Math.max(0, Math.min(op.index, parent.children.length));
        parent.children.splice(clamped, 0, op.node);
        break;
      }
      case 'removeNode': {
        const found = findParent(draft, op.nodeId);
        if (!found) throw new PatchError(`Node not found or is root: ${op.nodeId}`, op);
        found.parent.children!.splice(found.index, 1);
        break;
      }
      case 'setBrandToken': {
        draft.brandTokens = { ...(draft.brandTokens ?? {}), [op.key]: op.value };
        break;
      }
      default: {
        const _exhaustive: never = op;
        throw new PatchError(`Unknown op: ${JSON.stringify(_exhaustive)}`, op as PatchOp);
      }
    }
    draft.meta.updatedAt = new Date().toISOString();
  });
}

export function applyPatches(doc: DesignDoc, ops: PatchOp[]): DesignDoc {
  return ops.reduce((d, op) => applyPatch(d, op), doc);
}
