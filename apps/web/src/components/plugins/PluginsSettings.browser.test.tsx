import { EnvironmentId, type PluginDiscoveryItem } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const session = vi.hoisted(() => ({
  act: vi.fn(async (_value: unknown) => ({ _tag: "Success", value: undefined })),
  canDecide: true,
  plugins: [] as ReadonlyArray<PluginDiscoveryItem>,
}));

vi.mock("./pluginState", () => ({
  pluginDiscovery: { state: () => ({}), act: { permissionAtom: () => ({}) } },
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => session.canDecide,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => session.act }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    error: null,
    isPending: false,
    data: { plugins: session.plugins },
  }),
}));
vi.mock("../settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environment: { environmentId: "env" } }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../settings/settingsLayout", () => ({
  SettingsPageContainer: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
  SettingsSection: (props: { title: string; children: React.ReactNode }) => (
    <section aria-label={props.title}>{props.children}</section>
  ),
}));

import { PLUGINS_FOUND_EXPLANATION, PluginsSettingsPanel } from "./PluginsSettings";

const environmentId = EnvironmentId.make("env");
const offered = (id: string, name: string): PluginDiscoveryItem => ({
  id,
  name,
  state: "offered",
  baseUrl: `http://127.0.0.1:9/${id}`,
  live: true,
});

function setup(plugins: ReadonlyArray<PluginDiscoveryItem>, canDecide = true) {
  session.act.mockClear();
  session.plugins = plugins;
  session.canDecide = canDecide;
}

it("enables the checked new plugins and dismisses the rest", async () => {
  setup([offered("bullseye", "Bullseye"), offered("other", "Other")]);
  await using _screen = await render(<PluginsSettingsPanel />);
  await expect.element(page.getByText(PLUGINS_FOUND_EXPLANATION)).toBeVisible();
  await expect.element(page.getByRole("checkbox", { name: "Enable Bullseye" })).not.toBeChecked();
  await page.getByText("Bullseye", { exact: true }).click();
  await expect.element(page.getByRole("checkbox", { name: "Enable Bullseye" })).toBeChecked();
  await page.getByRole("button", { name: "Enable selected" }).click();
  await vi.waitFor(() => expect(session.act).toHaveBeenCalledTimes(2));
  expect(session.act.mock.calls.map(([value]) => value)).toEqual([
    {
      environmentId,
      input: { action: "enable", id: "bullseye", baseUrl: "http://127.0.0.1:9/bullseye" },
    },
    { environmentId, input: { action: "dismiss", id: "other" } },
  ]);
});

it("defers without changing anything and toggles settled plugins", async () => {
  setup([
    offered("bullseye", "Bullseye"),
    { ...offered("ledger", "Ledger"), state: "enabled" },
    { ...offered("old", "Old"), state: "dismissed" },
  ]);
  await using _screen = await render(<PluginsSettingsPanel />);
  await page.getByRole("button", { name: "Not now" }).click();
  await expect.element(page.getByText(PLUGINS_FOUND_EXPLANATION)).not.toBeInTheDocument();
  expect(session.act).not.toHaveBeenCalled();
  await page.getByText("Ledger", { exact: true }).click();
  expect(session.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "disable", id: "ledger" },
  });
  await page.getByRole("button", { name: "Ask again" }).click();
  expect(session.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { action: "reset", id: "old" },
  });
});

it("shows plugins to readers who may not change them", async () => {
  setup(
    [offered("bullseye", "Bullseye"), { ...offered("ledger", "Ledger"), state: "enabled" }],
    false,
  );
  await using _screen = await render(<PluginsSettingsPanel />);
  await expect.element(page.getByRole("checkbox", { name: "Enable Bullseye" })).toBeDisabled();
  await expect.element(page.getByRole("checkbox", { name: "Ledger enabled" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Enable selected" })).toBeDisabled();
});
