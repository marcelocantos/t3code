import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

vi.mock("@t3tools/client-runtime/state/panelPlugins", () => ({
  createPanelPluginAtoms: () => (input: unknown) => input,
}));
vi.mock("@t3tools/client-runtime/state/pluginDiscovery", () => ({
  createPluginDiscoveryAtoms: () => ({
    state: () => ({ discovery: true }),
    act: { permissionAtom: () => ({ permission: true }) },
  }),
  describePluginDiscoveryItem: () => "",
  pluginDiscoveryChoices: () => [],
  pluginNeedsDecision: () => false,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: {
    discovery?: true;
    input: { threadId: string; filters: { filter: string }[] };
  }) => ({
    error: null,
    data: query.discovery
      ? { plugins: [] }
      : [
          {
            pluginId: "bullseye",
            status: "connected",
            panels: [
              {
                id: "targets",
                title: "Bullseye",
                filter: query.input.filters[0]?.filter ?? "frontier",
                filters: [
                  { id: "frontier", label: "Frontier" },
                  { id: "all", label: "All" },
                ],
                rows: [
                  {
                    id: "T123.456.789",
                    label: `🎯T123.456.789 ${query.input.threadId} A long target label that must wrap within a narrow sidebar without clipping`,
                    detail: "A detail line",
                  },
                ],
              },
            ],
          },
        ],
  }),
}));

import { ThreadPluginPanels } from "./ThreadPluginPanels";

it("wraps long targets in a narrow sidebar and resets filters across threads", async () => {
  const panel = (thread: string) => (
    <div style={{ width: 240 }}>
      <ThreadPluginPanels
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make(thread)}
      />
    </div>
  );
  await using screen = await render(panel("first"));
  await expect
    .element(page.getByRole("combobox", { name: "Bullseye filter" }))
    .toHaveValue("frontier");
  const row = screen.container.querySelector("li");
  expect(row).not.toBeNull();
  expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth);
  expect(row!.getBoundingClientRect().height).toBeGreaterThan(30);
  await page.getByRole("combobox", { name: "Bullseye filter" }).selectOptions("all");
  await expect.element(page.getByRole("combobox")).toHaveValue("all");
  await screen.rerender(panel("second"));
  await expect.element(page.getByRole("combobox")).toHaveValue("frontier");
  await expect.element(page.getByText(/second A long target/)).toBeVisible();
});
