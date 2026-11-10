import { EnvironmentId, type PluginDiscoveryItem } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const act = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  canDecide: true,
  plugins: [] as ReadonlyArray<PluginDiscoveryItem>,
}));

vi.mock("@t3tools/client-runtime/state/pluginDiscovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/pluginDiscovery")>()),
  createPluginDiscoveryAtoms: () => ({
    state: () => ({}),
    act: { permissionAtom: () => ({}) },
  }),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => session.canDecide,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => act }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ error: null, data: { plugins: session.plugins } }),
}));

import { PluginDiscoveryPanel } from "./PluginDiscoveryPanel";

const environmentId = EnvironmentId.make("env");
const offered: PluginDiscoveryItem = {
  id: "example",
  name: "Example",
  state: "offered",
  baseUrl: "http://127.0.0.1:9/plugins/t3",
  live: true,
};

it("asks before enabling an advertised plugin and consents to the endpoint it shows", async () => {
  act.mockClear();
  session.canDecide = true;
  session.plugins = [offered];
  await using _screen = await render(<PluginDiscoveryPanel environmentId={environmentId} />);
  await expect.element(page.getByText(/Example is running at 127.0.0.1:9/)).toBeVisible();
  await page.getByRole("button", { name: "Enable" }).click();
  expect(act).toHaveBeenCalledWith({
    environmentId,
    input: { action: "enable", id: "example", baseUrl: "http://127.0.0.1:9/plugins/t3" },
  });
  await page.getByRole("button", { name: "Dismiss" }).click();
  expect(act).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "dismiss", id: "example" },
  });
});

it("keeps settled plugins collapsed and lets a dismissed one be reset", async () => {
  act.mockClear();
  session.canDecide = true;
  session.plugins = [{ ...offered, state: "dismissed" }];
  await using _screen = await render(<PluginDiscoveryPanel environmentId={environmentId} />);
  await expect.element(page.getByText("Plugins found")).not.toBeInTheDocument();
  await page.getByText("1 plugin").click();
  await page.getByRole("button", { name: "Ask again" }).click();
  expect(act).toHaveBeenCalledWith({
    environmentId,
    input: { action: "reset", id: "example" },
  });
});

it("shows decisions to readers who may not change them", async () => {
  act.mockClear();
  session.canDecide = false;
  session.plugins = [offered];
  await using _screen = await render(<PluginDiscoveryPanel environmentId={environmentId} />);
  await expect.element(page.getByRole("button", { name: "Enable" })).toBeDisabled();
});
