import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const LINK_CARD = "link-card";
const state = vi.hoisted(() => ({
  card: vi.fn(async (_request: unknown) => ({
    _tag: "Success",
    value: {
      surface: { title: "pacs.008 123", blocks: [{ type: "text", text: "Settled" }] },
    },
  })),
  activate: vi.fn(async (_request: unknown): Promise<unknown> => ({ _tag: "Failure" })),
  activateCommand: { permissionAtom: (): unknown => undefined },
}));

vi.mock("./pluginState", async () => {
  const { Atom } = await import("effect/reactivity");
  const permitted = Atom.make(true);
  state.activateCommand.permissionAtom = () => permitted;
  return {
    pluginPanelCommands: { act: {}, surface: {} },
    pluginLinks: { links: () => ({}), card: "link-card", activate: state.activateCommand },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: [
      { pluginId: "viewer", linkId: "message", prefix: "https://viewer.example/msg/" },
      { pluginId: "opener", linkId: "markdown", glob: "/**/*.md", click: "activate", card: false },
      { pluginId: "viewer", linkId: "doc", glob: "/docs/*.md", click: "activate", hover: false },
    ],
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === LINK_CARD
      ? state.card
      : command === state.activateCommand
        ? state.activate
        : vi.fn(),
}));

import { PluginFileLink, PluginLinkHover } from "./PluginLinkHover";

const environmentId = EnvironmentId.make("env");

function ChatLink({ href, label }: { href: string; label: string }) {
  const link = (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
  return (
    <PluginLinkHover environmentId={environmentId} href={href} link={link} local={false}>
      <span data-testid="fallback">{link}</span>
    </PluginLinkHover>
  );
}

it("shows a plugin's card for a declared link on hover, cached, and closes it on Escape", async () => {
  state.card.mockClear();
  const url = "https://viewer.example/msg/123";
  await using screen = await render(
    <p>
      <ChatLink href={url} label="message 123" />{" "}
      <ChatLink href="https://elsewhere.example/msg/123" label="elsewhere" />
    </p>,
  );
  // Other links keep their usual rendering; nothing is fetched until a hover.
  await expect.element(screen.getByTestId("fallback")).toHaveTextContent("elsewhere");
  expect(state.card).not.toHaveBeenCalled();

  const link = screen.getByRole("link", { name: "message 123" });
  await userEvent.hover(link);
  await expect.element(page.getByText("Settled")).toBeVisible();
  expect(state.card).toHaveBeenCalledWith({
    environmentId,
    input: { pluginId: "viewer", linkId: "message", url },
  });
  await expect.element(link).toHaveAttribute("href", url);

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Settled")).not.toBeInTheDocument();

  // The second hover is served from the page session's cache.
  await userEvent.unhover(link);
  await userEvent.hover(link);
  await expect.element(page.getByText("pacs.008 123")).toBeVisible();
  expect(state.card).toHaveBeenCalledTimes(1);
});

it("offers a plain click to a plugin that activates links, and falls back when it declines", async () => {
  const opened = vi.fn();
  await using screen = await render(
    <PluginFileLink environmentId={environmentId} path="/work/notes.md" local>
      <button type="button" onClick={opened}>
        notes.md
      </button>
    </PluginFileLink>,
  );
  const chip = screen.getByRole("button", { name: "notes.md" });
  const asked = { pluginId: "opener", linkId: "markdown", url: "/work/notes.md" };

  // Handled: the chip's own click never runs.
  state.activate.mockResolvedValueOnce({ _tag: "Success", value: { handled: true } });
  await userEvent.click(chip);
  await vi.waitFor(() => expect(state.activate).toHaveBeenCalledTimes(1));
  expect(state.activate).toHaveBeenCalledWith({
    environmentId,
    input: { ...asked, client: { local: true } },
  });
  expect(opened).not.toHaveBeenCalled();

  // Declined, or failed (timeout, disconnected plugin): the click runs as if unclaimed.
  state.activate.mockResolvedValueOnce({ _tag: "Success", value: { handled: false } });
  await userEvent.click(chip);
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
  state.activate.mockResolvedValueOnce({ _tag: "Failure" });
  await userEvent.click(chip);
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
  expect(state.activate).toHaveBeenCalledTimes(3);

  // A modified click keeps the link's own behaviour.
  await userEvent.click(chip, { modifiers: ["Meta"] });
  expect(opened).toHaveBeenCalledTimes(3);
  expect(state.activate).toHaveBeenCalledTimes(3);
});

it("shows a click-only card when the plugin declines a click, and nothing on focus", async () => {
  state.card.mockClear();
  const opened = vi.fn();
  await using screen = await render(
    <PluginFileLink environmentId={environmentId} path="/docs/plan.md" local={false}>
      <button type="button" onClick={opened}>
        plan.md
      </button>
    </PluginFileLink>,
  );
  const chip = screen.getByRole("button", { name: "plan.md" });

  // `hover: false`: focus (and hover) never fetch the card.
  chip.element().focus();
  expect(state.card).not.toHaveBeenCalled();

  // Declined: the card opens in place of the click.
  state.activate.mockResolvedValueOnce({ _tag: "Success", value: { handled: false } });
  await userEvent.click(chip);
  await expect.element(page.getByText("Settled")).toBeVisible();
  expect(state.card).toHaveBeenCalledWith({
    environmentId,
    input: { pluginId: "viewer", linkId: "doc", url: "/docs/plan.md" },
  });
  expect(opened).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("Settled")).not.toBeInTheDocument();

  // A failed activation still does what an unclaimed link does.
  state.activate.mockResolvedValueOnce({ _tag: "Failure" });
  await userEvent.click(chip);
  await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
});
