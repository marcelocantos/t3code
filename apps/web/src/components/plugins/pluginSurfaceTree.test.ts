import { expect, it } from "vite-plus/test";
import { PluginSurfaceTree, type PluginSurfaceTreeNode } from "./pluginSurfaceTree";

it("closes descendants with their parent and replaces a panel's hover card", () => {
  const tree = new PluginSurfaceTree<PluginSurfaceTreeNode>();
  const closed: Array<[string, string, unknown]> = [];
  const node = (id: string, parentId: string | null, transientKey?: string) => ({
    id,
    parentId,
    transientKey,
    onClosed: (reason: string, result?: unknown) => void closed.push([id, reason, result]),
  });
  tree.open(node("dialog", null));
  tree.open(node("child", "dialog"));
  tree.open(node("grandchild", "child"));
  tree.open(node("other", null));
  expect(tree.open(node("orphan", "missing"))).toBe(false);

  tree.close("dialog", "closed", { picked: 1 });
  expect(tree.nodes.map((entry) => entry.id)).toEqual(["other"]);
  expect(closed).toEqual([
    ["grandchild", "parent", undefined],
    ["child", "parent", undefined],
    ["dialog", "closed", { picked: 1 }],
  ]);

  closed.length = 0;
  tree.open(node("hover-a", null, "panel"));
  tree.open(node("hover-b", null, "panel"));
  expect(tree.nodes.map((entry) => entry.id)).toEqual(["other", "hover-b"]);
  expect(closed).toEqual([["hover-a", "dismissed", undefined]]);
});
