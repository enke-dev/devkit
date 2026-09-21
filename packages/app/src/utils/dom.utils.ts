import type { DomChange, DomNode, Engine } from '@devkit/protocol';

/**
 * The app's copy of one engine's DOM, and the small amount of reasoning that
 * turns a stream of slices into rows on a screen.
 *
 * Held per engine and never merged. The panes' trees are the thing being
 * compared and folding them into one would decide, silently and in this file,
 * which engine was right — so the view shows one engine's tree at a time and
 * the styles table underneath goes on answering for all three, which is the
 * comparison this app is actually for.
 *
 * Nothing here talks to the sidecar. It is told what arrived and says what is
 * now missing, and the app component does the asking.
 */

/**
 * The tree as it crosses a window boundary.
 *
 * The same thing with its maps and sets spelled as arrays, because the detached
 * inspector is reached through an event channel that carries JSON and a `Map`
 * arrives there as `{}`. Whole rather than incremental, like every other piece
 * of state the detached window is sent except the console — it changes when
 * somebody opens a twisty, which is far too rarely to be worth a diff protocol
 * that both sides would have to agree about.
 */
export interface DomTreeWire {
  engine: Engine;
  nodes: [string, DomNode][];
  children: [string, string[]][];
  parents: [string, string][];
  rootId: string | null;
  expanded: string[];
  selectedId: string | null;
}

export function toWire(tree: DomTree): DomTreeWire {
  return {
    engine: tree.engine,
    nodes: [...tree.nodes],
    children: [...tree.children],
    parents: [...tree.parents],
    rootId: tree.rootId,
    expanded: [...tree.expanded],
    selectedId: tree.selectedId,
  };
}

export function fromWire(wire: DomTreeWire): DomTree {
  return {
    engine: wire.engine,
    nodes: new Map(wire.nodes),
    children: new Map(wire.children),
    parents: new Map(wire.parents),
    rootId: wire.rootId,
    expanded: new Set(wire.expanded),
    selectedId: wire.selectedId,
  };
}

/** One engine's tree, as far as it has been asked for. */
export interface DomTree {
  engine: Engine;
  /** Every node this pane has described, by its handle. */
  nodes: Map<string, DomNode>;
  /** Child handles in document order, absent until that node's children arrived. */
  children: Map<string, string[]>;
  /** Which node each node hangs under, so an identity can be read upwards. */
  parents: Map<string, string>;
  rootId: string | null;
  expanded: Set<string>;
  selectedId: string | null;
}

/**
 * One line of the flattened tree.
 *
 * Flattened rather than rendered as nested elements, because the list is
 * windowed: a page with forty thousand nodes has to cost what is on screen, and
 * nested markup costs the whole open subtree whether or not any of it is in
 * view.
 */
export interface DomRow {
  /** Identifies the row for keyed rendering; a handle, or a handle and a pseudo. */
  key: string;
  node: DomNode;
  depth: number;
  /**
   * Set on the two rows that stand for generated content.
   *
   * They have no node of their own — nothing in the DOM does — so they carry
   * the element they belong to and are drawn from `pseudo` rather than from
   * anything the walker could hand back.
   */
  pseudo?: 'before' | 'after';
  expanded: boolean;
  /** Whether this row has a twisty at all. */
  openable: boolean;
  /** Whether opening it would need a round trip first. */
  loaded: boolean;
}

export function emptyTree(engine: Engine): DomTree {
  return {
    engine,
    nodes: new Map(),
    children: new Map(),
    parents: new Map(),
    rootId: null,
    expanded: new Set(),
    selectedId: null,
  };
}

/**
 * Take in a slice of tree.
 *
 * Nodes are stored without their nested children: a node that carries its own
 * subtree would be two descriptions of the same rows, and the stale one is
 * whichever was not updated last. The nesting is unpicked into the child map
 * on the way in and never put back.
 *
 * `parentId` is null for the answer to a `dom-root`, which is the only slice
 * that arrives without one.
 */
export function absorb(tree: DomTree, parentId: string | null, nodes: DomNode[]): DomTree {
  const store = (node: DomNode, parent: string | null): void => {
    const { children, ...flat } = node;
    tree.nodes.set(node.nodeId, flat);
    if (parent !== null) {
      tree.parents.set(node.nodeId, parent);
    }
    if (children) {
      tree.children.set(
        node.nodeId,
        children.map(child => child.nodeId)
      );
      children.forEach(child => store(child, node.nodeId));
    }
  };

  nodes.forEach(node => store(node, parentId));
  if (parentId === null) {
    tree.rootId = nodes[0]?.nodeId ?? null;
  } else {
    tree.children.set(
      parentId,
      nodes.map(node => node.nodeId)
    );
  }
  return { ...tree };
}

/**
 * The rows to draw, outermost first.
 *
 * Generated content sits directly under its element and above the real
 * children, which is where the engines put the boxes and where every other DOM
 * view shows them.
 */
export function rowsOf(tree: DomTree): DomRow[] {
  const walk = (id: string, depth: number): DomRow[] => {
    const node = tree.nodes.get(id);
    if (!node) {
      return [];
    }
    const children = tree.children.get(id);
    const pseudo = node.pseudo ?? [];
    const row: DomRow = {
      key: id,
      node,
      depth,
      expanded: tree.expanded.has(id),
      openable: node.childCount > 0 || pseudo.length > 0,
      loaded: children !== undefined,
    };
    if (!row.expanded) {
      return [row];
    }
    return [
      row,
      ...pseudo.map(which => ({
        key: `${id}::${which}`,
        node,
        depth: depth + 1,
        pseudo: which,
        expanded: false,
        openable: false,
        loaded: true,
      })),
      ...(children ?? []).flatMap(child => walk(child, depth + 1)),
    ];
  };
  return tree.rootId === null ? [] : walk(tree.rootId, 0);
}

/**
 * What a row says, in the shorthand a DOM view uses.
 *
 * Not the markup. A row is one line however long the element's attribute list
 * is, and an opening tag rendered faithfully would push the tag name — the part
 * anybody is scanning for — off the end of it.
 */
export function labelOf(node: DomNode): string {
  if (node.kind === 'text' || node.kind === 'comment') {
    return node.value ?? '';
  }
  if (node.kind !== 'element') {
    return node.name;
  }
  const id = node.id ? `#${node.id}` : '';
  return `${node.name}${id}${node.classes.map(name => `.${name}`).join('')}`;
}

/**
 * The identity chain from the document down to a node.
 *
 * What one pane hands the other two to mean "that element". Read upwards from
 * the node because that is the direction the parent map runs, and reversed
 * because that is the direction a chain is walked down in.
 */
export function stepsTo(tree: DomTree, nodeId: string): string[] {
  const climb = (id: string, seen: string[]): string[] => {
    const node = tree.nodes.get(id);
    if (!node) {
      return seen;
    }
    const chain = [node.step, ...seen];
    const parent = tree.parents.get(id);
    return parent === undefined ? chain : climb(parent, chain);
  };
  return climb(nodeId, []);
}

/**
 * Which subtrees the panes should be watching.
 *
 * The expanded nodes whose children actually arrived, and no others: watching a
 * node the app has not drawn the inside of produces changes it would have to
 * throw away, and the point of naming the set at all is that the page only pays
 * for what is on screen.
 */
export function watchIds(tree: DomTree): string[] {
  return [...tree.expanded].filter(id => tree.children.has(id));
}

/**
 * Everything under a node, including the node.
 *
 * Used when a node goes: the app is holding handles for rows it can no longer
 * draw, and a stale subtree left behind would reappear the next time its parent
 * was expanded.
 */
function subtreeOf(tree: DomTree, id: string): string[] {
  const children = tree.children.get(id) ?? [];
  return [id, ...children.flatMap(child => subtreeOf(tree, child))];
}

function forget(tree: DomTree, id: string): void {
  subtreeOf(tree, id).forEach(gone => {
    tree.nodes.delete(gone);
    tree.children.delete(gone);
    tree.parents.delete(gone);
    tree.expanded.delete(gone);
    if (tree.selectedId === gone) {
      tree.selectedId = null;
    }
  });
}

/**
 * Apply what a pane said had changed, and say what has to be asked for again.
 *
 * A changed child list is deliberately *not* applied: the pane said the list is
 * different, not what it now is, because sending the new list would have been
 * the expensive half of a refetch for every node that so much as reordered. So
 * the cached list is dropped and the node named — the app asks for it again
 * only if it is still open, which is the only case where anybody can see it.
 */
export function applyChanges(
  tree: DomTree,
  changes: DomChange[]
): { tree: DomTree; refetch: string[] } {
  const refetch: string[] = [];

  changes.forEach(change => {
    const node = tree.nodes.get(change.nodeId);
    switch (change.kind) {
      case 'removed':
        if (node) {
          const parent = tree.parents.get(change.nodeId);
          if (parent !== undefined) {
            tree.children.set(
              parent,
              (tree.children.get(parent) ?? []).filter(id => id !== change.nodeId)
            );
          }
          forget(tree, change.nodeId);
        }
        return;

      case 'children':
        if (node) {
          tree.nodes.set(change.nodeId, { ...node, childCount: change.childCount });
        }
        if (tree.children.has(change.nodeId)) {
          tree.children.delete(change.nodeId);
          if (tree.expanded.has(change.nodeId)) {
            refetch.push(change.nodeId);
          }
        }
        return;

      case 'attributes':
        if (node) {
          tree.nodes.set(change.nodeId, {
            ...node,
            classes: change.classes,
            attributes: change.attributes,
            ...(change.id === undefined ? {} : { id: change.id }),
          });
        }
        return;

      case 'value':
        if (node) {
          tree.nodes.set(change.nodeId, { ...node, value: change.value });
        }
        return;
    }
  });

  return { tree: { ...tree }, refetch };
}

/**
 * Open a node, and say whether its children have to be fetched first.
 *
 * Expanding is recorded either way. A twisty that only turned once the round
 * trip came back felt broken on a slow page, and the row draws perfectly well
 * with nothing under it for the moment it takes.
 */
export function expand(tree: DomTree, nodeId: string): { tree: DomTree; fetch: boolean } {
  tree.expanded.add(nodeId);
  return { tree: { ...tree }, fetch: !tree.children.has(nodeId) };
}

export function collapse(tree: DomTree, nodeId: string): DomTree {
  tree.expanded.delete(nodeId);
  return { ...tree };
}

/**
 * Open everything on the way to a node, so a row nobody walked down to can be
 * shown.
 *
 * What the picker and the search results both need. The ancestors are the
 * pane's own handles, in the pane's own order, so this is only ever applied to
 * the tree of the engine that produced them.
 */
export function reveal(tree: DomTree, ancestors: string[]): { tree: DomTree; fetch: string[] } {
  ancestors.forEach(id => tree.expanded.add(id));
  return { tree: { ...tree }, fetch: ancestors.filter(id => !tree.children.has(id)) };
}

/**
 * Where a node sits among the rows, for scrolling it into view.
 *
 * -1 when it is not drawn at all, which is the ordinary state of a node whose
 * ancestors are still being fetched — the caller tries again when they land.
 */
export function rowIndexOf(rows: DomRow[], nodeId: string | null): number {
  return nodeId === null ? -1 : rows.findIndex(row => row.key === nodeId);
}
