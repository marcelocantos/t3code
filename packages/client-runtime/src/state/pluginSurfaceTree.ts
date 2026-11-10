import type { PluginSurfaceCloseReason } from "./pluginBridge.ts";

export interface PluginSurfaceTreeNode {
  readonly id: string;
  readonly parentId: string | null;
  /** Set on a hover card; one per key, replaced by the next. Pinning clears it. */
  readonly transientKey?: string | undefined;
  readonly onClosed?: ((reason: PluginSurfaceCloseReason, result?: unknown) => void) | undefined;
}

/**
 * Open plugin surfaces as an owner tree: closing a surface closes everything it opened, each told
 * why. Rendering reads `nodes`; handlers mutate through the methods.
 */
export class PluginSurfaceTree<Node extends PluginSurfaceTreeNode> {
  nodes: ReadonlyArray<Node> = [];
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  read = () => this.nodes;

  newId() {
    this.nextId += 1;
    return `surface-${this.nextId}`;
  }

  get(id: string) {
    return this.nodes.find((node) => node.id === id);
  }

  open(node: Node) {
    if (node.parentId !== null && this.get(node.parentId) === undefined) return false;
    if (node.transientKey !== undefined) {
      const previous = this.nodes.find((candidate) => candidate.transientKey === node.transientKey);
      if (previous !== undefined) this.close(previous.id, "dismissed");
    }
    this.set([...this.nodes, node]);
    return true;
  }

  update(id: string, patch: Partial<Node>) {
    if (this.get(id) === undefined) return;
    this.set(this.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)));
  }

  /** Closes `id` with `reason` and its descendants with `"parent"`, deepest first. */
  close(id: string, reason: PluginSurfaceCloseReason, result?: unknown) {
    const target = this.get(id);
    if (target === undefined) return;
    const doomed = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const node of this.nodes) {
        if (node.parentId !== null && doomed.has(node.parentId) && !doomed.has(node.id)) {
          doomed.add(node.id);
          grew = true;
        }
      }
    }
    // `filter` copies; Hermes lacks `toReversed`.
    const closing = this.nodes.filter((node) => doomed.has(node.id)).reverse();
    this.set(this.nodes.filter((node) => !doomed.has(node.id)));
    for (const node of closing) {
      if (node.id === id) node.onClosed?.(reason, result);
      else node.onClosed?.("parent");
    }
  }

  /** Drops everything without notifying, for a host that is going away with its frames. */
  dispose() {
    this.set([]);
  }

  private set(nodes: ReadonlyArray<Node>) {
    this.nodes = nodes;
    for (const listener of this.listeners) listener();
  }
}
