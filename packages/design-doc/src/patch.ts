import { produce } from 'immer';
import type { DesignDoc, NodeInstance, Page } from './schema.js';

export type PatchOp =
  | { kind: 'setProp'; nodeId: string; key: string; value: unknown }
  | { kind: 'setProps'; nodeId: string; props: Record<string, unknown> }
  | { kind: 'setBind'; nodeId: string; key: string; path: string | null }
  | { kind: 'reorderChildren'; parentId: string; order: string[] }
  | { kind: 'insertNode'; parentId: string; index: number; node: NodeInstance }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'setBrandToken'; key: string; value: string }
  | { kind: 'addPage'; page: Page; index?: number }
  | { kind: 'removePage'; pageId: string }
  | { kind: 'renamePage'; pageId: string; name: string }
  | { kind: 'reorderPages'; order: string[] };

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
      case 'addPage': {
        // Invariant: unique page-ids. Rejecten hier voorkomt dat de UI in
        // een inconsistente state komt bij Claude die per ongeluk een
        // bestaande id hergebruikt.
        if (draft.pages.some((p) => p.id === op.page.id)) {
          throw new PatchError(`Page id already exists: ${op.page.id}`, op);
        }
        const idx =
          op.index === undefined
            ? draft.pages.length
            : Math.max(0, Math.min(op.index, draft.pages.length));
        draft.pages.splice(idx, 0, op.page);
        break;
      }
      case 'removePage': {
        const idx = draft.pages.findIndex((p) => p.id === op.pageId);
        if (idx < 0) throw new PatchError(`Page not found: ${op.pageId}`, op);
        // Doc-invariant: minstens één pagina (DesignDocSchema pages.min(1)).
        if (draft.pages.length === 1) {
          throw new PatchError(`Cannot remove the only remaining page`, op);
        }
        draft.pages.splice(idx, 1);
        break;
      }
      case 'renamePage': {
        const page = draft.pages.find((p) => p.id === op.pageId);
        if (!page) throw new PatchError(`Page not found: ${op.pageId}`, op);
        page.name = op.name;
        break;
      }
      case 'reorderPages': {
        const map = new Map(draft.pages.map((p) => [p.id, p]));
        const next = op.order.map((id) => map.get(id));
        if (next.some((p) => !p) || next.length !== draft.pages.length) {
          throw new PatchError(`reorderPages order mismatch`, op);
        }
        draft.pages = next as typeof draft.pages;
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
