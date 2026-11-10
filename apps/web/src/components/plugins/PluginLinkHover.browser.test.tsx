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
}));

vi.mock("./pluginState", () => ({
  pluginPanelCommands: { act: {}, surface: {} },
  pluginLinks: { links: () => ({}), card: "link-card" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: [{ pluginId: "viewer", linkId: "message", prefix: "https://viewer.example/msg/" }],
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === LINK_CARD ? state.card : vi.fn()),
}));

import { PluginLinkHover } from "./PluginLinkHover";

const environmentId = EnvironmentId.make("env");

function ChatLink({ href, label }: { href: string; label: string }) {
  const link = (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
  return (
    <PluginLinkHover environmentId={environmentId} href={href} link={link}>
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
