import { minuteTick } from "@t3tools/client-runtime/clock";
import { pluginDateChoices } from "@t3tools/client-runtime/state/panelPlugins";
import { EnvironmentId, ThreadId, type PluginPanelRow } from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const plugin = vi.hoisted(() => ({
  act: vi.fn(async (_value: unknown) => ({ _tag: "Success", value: {} })),
  surface: vi.fn(async (_value: unknown) => ({
    _tag: "Success",
    value: {
      title: "Target T1",
      width: 400,
      blocks: [
        { type: "heading", text: "Target T1" },
        { type: "fields", items: [{ label: "Status", value: "Open" }] },
      ],
    },
  })),
  rows: null as ReadonlyArray<PluginPanelRow> | null,
}));

vi.mock("@t3tools/client-runtime/state/panelPlugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/panelPlugins")>()),
  createPanelPluginAtoms: () => (input: unknown) => input,
  createEnvironmentPanelPluginAtoms: () => (input: unknown) => input,
  createPanelPluginCommands: () => ({
    act: { kind: "act", permissionAtom: () => ({}) },
    surface: { kind: "surface", permissionAtom: () => ({}) },
  }),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../plugins/pluginAgent", () => ({ usePluginThreadAgent: () => null }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "act" ? plugin.act : plugin.surface,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { input: { threadId: string; filters: { filter: string }[] } }) => ({
    error: null,
    data: [
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
            rows: plugin.rows ?? [
              {
                id: "T123.456.789",
                label: `🎯T123.456.789 ${query.input.threadId} A long target label that must wrap within a narrow sidebar without clipping`,
                detail: "A detail line",
              },
              ...Array.from({ length: 40 }, (_, index) => ({
                id: `target-${index}`,
                label: `Target ${index}: More work with a long description that wraps`,
              })),
            ],
          },
        ],
      },
    ],
  }),
}));

import { ThreadPluginPanels } from "./ThreadPluginPanels";

const environmentId = EnvironmentId.make("env");
const rowTarget = {
  target: { scope: "thread", threadId: "first" },
  pluginId: "bullseye",
  panelId: "targets",
  rowId: "T1",
};

function setup(rows: ReadonlyArray<PluginPanelRow> | null) {
  plugin.rows = rows;
  plugin.act.mockClear();
  plugin.surface.mockClear();
}

const panel = (thread: string) => (
  // The details sidebar sits at the window's right edge.
  <div style={{ width: 240, marginLeft: "auto" }}>
    <ThreadPluginPanels environmentId={environmentId} threadId={ThreadId.make(thread)} />
  </div>
);

it("wraps long targets in a narrow sidebar and resets filters across threads", async () => {
  setup(null);
  using _storage = vi.spyOn(Storage.prototype, "getItem").mockReturnValue(null);
  await using screen = await render(panel("first"));
  await expect
    .element(page.getByRole("combobox", { name: "Bullseye filter" }))
    .toHaveValue("frontier");
  const row = screen.container.querySelector("li");
  expect(row).not.toBeNull();
  expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth);
  expect(row!.getBoundingClientRect().height).toBeGreaterThan(30);
  const content = screen.container.querySelector('[aria-label="Bullseye content"]') as HTMLElement;
  expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
  expect(content.clientHeight).toBeLessThanOrEqual(320);
  content.scrollTop = content.scrollHeight;
  expect(content.scrollTop).toBeGreaterThan(0);
  // Dragging the bottom border resizes the panel; the arrow keys step it when focused.
  const border = screen.container.querySelector('[aria-label="Resize Bullseye"]') as HTMLElement;
  const startHeight = content.getBoundingClientRect().height;
  const borderY = border.getBoundingClientRect().top;
  const pointer = (type: string, clientY: number) =>
    border.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 7,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientY,
        pointerType: "mouse",
        bubbles: true,
      }),
    );
  pointer("pointerdown", borderY);
  pointer("pointermove", borderY - 1000);
  pointer("pointerup", borderY - 1000);
  await vi.waitFor(() => expect(content.clientHeight).toBe(120));
  expect(startHeight).toBeGreaterThan(120);
  border.focus();
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(content.clientHeight).toBe(140));
  expect(screen.container.querySelector('input[type="range"]')).toBeNull();
  await page.getByRole("combobox", { name: "Bullseye filter" }).selectOptions("all");
  await expect.element(page.getByRole("combobox")).toHaveValue("all");
  await screen.rerender(panel("second"));
  await expect.element(page.getByRole("combobox")).toHaveValue("frontier");
  await expect.element(page.getByText(/second A long target/)).toBeVisible();
  // The height the user chose follows the panel to the next thread.
  await vi.waitFor(() =>
    expect(
      (screen.container.querySelector('[aria-label="Bullseye content"]') as HTMLElement)
        .clientHeight,
    ).toBe(140),
  );
});

it("offers a row's primary action, a menu with the rest, and date shortcuts", async () => {
  setup([
    {
      id: "T1",
      label: "Ship the thing",
      badges: [{ label: "blocked", tone: "warning" }],
      primaryActionId: "done",
      actions: [
        { kind: "plugin", id: "done", label: "Done" },
        { kind: "date", id: "snooze", label: "Snooze", value: "2026-12-01", clearLabel: "Wake" },
        {
          kind: "menu",
          id: "more",
          label: "Priority",
          items: [{ kind: "plugin", id: "high", label: "High" }],
        },
      ],
    },
  ]);
  await using _screen = await render(panel("first"));
  await expect.element(page.getByText("blocked")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  expect(plugin.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...rowTarget, actionId: "done" },
  });

  await page.getByRole("button", { name: "More actions for Ship the thing" }).click();
  await page.getByRole("menuitem", { name: /Snooze/ }).click();
  // The menu resolves shortcuts from the app's minute clock, which is UTC without a suffix.
  const [tomorrow, , nextWeek] = pluginDateChoices(new Date(`${minuteTick.getSnapshot()}Z`));
  await expect
    .element(page.getByRole("menuitem", { name: `Next week${nextWeek!.hint}` }))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Custom…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Wake" })).toBeVisible();
  await page.getByRole("menuitem", { name: new RegExp(`^Tomorrow`) }).click();
  expect(plugin.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...rowTarget, actionId: "snooze", value: tomorrow!.value },
  });

  await page.getByRole("button", { name: "More actions for Ship the thing" }).click();
  await page.getByRole("menuitem", { name: /Snooze/ }).click();
  await page.getByRole("menuitem", { name: "Wake" }).click();
  expect(plugin.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...rowTarget, actionId: "snooze", value: null },
  });

  await page.getByRole("button", { name: "More actions for Ship the thing" }).click();
  await page.getByRole("menuitem", { name: "Priority" }).click();
  await page.getByRole("menuitem", { name: "High" }).click();
  expect(plugin.act).toHaveBeenLastCalledWith({
    environmentId,
    input: { ...rowTarget, actionId: "high" },
  });
});

it("shows a row's hover card over the chat, outside the panel's scroll box", async () => {
  setup([{ id: "T1", label: "Hover me", hoverSurfaceId: "card" }]);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1200, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await using screen = await render(panel("first"));
  const content = screen.container.querySelector('[aria-label="Bullseye content"]') as HTMLElement;
  await page.getByText("Hover me").hover();
  const card = page.getByRole("dialog", { name: "Target T1" });
  await expect.element(card).toBeVisible();
  expect(plugin.surface).toHaveBeenCalledWith({
    environmentId,
    input: { ...rowTarget, surfaceId: "card" },
  });
  const cardRect = card.element().getBoundingClientRect();
  const panelRect = content.getBoundingClientRect();
  expect(cardRect.width).toBeGreaterThanOrEqual(399);
  // It opens beside the row, toward the chat, past the panel's edge, and nothing clips it.
  const rowRect = screen.container.querySelector("li")!.getBoundingClientRect();
  expect(cardRect.right).toBeLessThanOrEqual(rowRect.left);
  expect(cardRect.left).toBeLessThan(panelRect.left - 300);
  const hit = document.elementFromPoint(
    cardRect.left + cardRect.width / 2,
    cardRect.top + cardRect.height / 2,
  );
  expect(card.element().contains(hit)).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.element(card).not.toBeInTheDocument();
});
