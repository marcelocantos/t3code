import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const host = vi.hoisted(() => ({
  confirm: vi.fn(async (_message: string) => true),
  submit: vi.fn(async (_source: string, _prompt: string) => null),
  act: vi.fn(),
}));

vi.mock("./pluginState", () => ({ pluginPanelCommands: { act: {}, surface: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => host.act }));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: host.confirm }));

import panelUrl from "../../../test/fixtures/plugin-bridge/panel.html?url";
import { PluginAgentContext, PluginFrame, PluginSurfaceHost } from "./PluginSurfaceHost";

// Served by the test server; the frames speak the bridge from inside a real sandbox.
const gateway = new URL("./", new URL(panelUrl, window.location.origin)).href;

it("lets a sandboxed panel open surfaces, read a child's result, and prompt the agent", async () => {
  host.confirm.mockClear();
  host.submit.mockClear();
  const reports: string[] = [];
  const listener = (event: MessageEvent) => {
    if (typeof event.data?.fixtureLog === "string") reports.push(event.data.fixtureLog);
  };
  window.addEventListener("message", listener);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", listener) };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1200, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const reported = (text: string) => vi.waitFor(() => expect(reports).toContain(text));
  await using _screen = await render(
    <PluginAgentContext
      value={{ runningSources: new Set(), submit: host.submit, stop: async () => null }}
    >
      <PluginSurfaceHost>
        <div style={{ width: 300, marginLeft: "auto" }}>
          <PluginFrame
            src={`${gateway}panel.html`}
            title="Counter panel"
            height={240}
            nodeId={null}
            ownSurfaceId={undefined}
            gatewayUrl={`${gateway}panel.html`}
            panelTitle="Counter"
            agentSource="frame:counter"
          />
        </div>
      </PluginSurfaceHost>
    </PluginAgentContext>,
  );
  const frameElement = page.getByTitle("Counter panel");
  const frame = page.frameLocator(frameElement);
  await reported("bridge ready");

  // A structured card anchored in the frame; its action goes back to the frame, not a plugin.
  await frame.getByRole("button", { name: "Open card" }).click();
  const card = page.getByRole("dialog", { name: "Card" });
  await expect.element(card).toBeVisible();
  const frameRect = frameElement.element().getBoundingClientRect();
  expect(card.element().getBoundingClientRect().right).toBeLessThanOrEqual(frameRect.left + 1);
  await card.getByRole("button", { name: "Reset" }).click();
  await reported("action reset");
  expect(host.act).not.toHaveBeenCalled();

  // A web child dialog closes itself with a result its opener receives.
  await frame.getByRole("button", { name: "Open dialog" }).click();
  const child = page.frameLocator(page.getByTitle("Counter", { exact: true }));
  await child.getByRole("button", { name: "Blue" }).click();
  await reported("picked blue");

  // Paths outside the panel's gateway directory never load.
  await frame.getByRole("button", { name: "Escape" }).click();
  await reported("error That path is outside this plugin.");

  // Prompts run only after a T3 confirmation naming the panel.
  await frame.getByRole("button", { name: "Ask" }).click();
  await reported("agent sent");
  expect(host.confirm).toHaveBeenCalledWith(
    "Send this message from Counter?\nSummarize the panel.",
  );
  expect(host.submit).toHaveBeenCalledWith("frame:counter", "Summarize the panel.");
});

it("hands the bridge again to a frame that asks after missing it", async () => {
  const reports: string[] = [];
  const listener = (event: MessageEvent) => {
    if (typeof event.data?.fixtureLog === "string") reports.push(event.data.fixtureLog);
  };
  window.addEventListener("message", listener);
  using _listener = { [Symbol.dispose]: () => window.removeEventListener("message", listener) };
  await using _screen = await render(
    <PluginSurfaceHost>
      <PluginFrame
        src={`${gateway}late-panel.html`}
        title="Late panel"
        height={120}
        nodeId={null}
        ownSurfaceId={undefined}
        gatewayUrl={`${gateway}late-panel.html`}
        panelTitle="Late"
        agentSource="frame:late"
      />
    </PluginSurfaceHost>,
  );
  await vi.waitFor(() => expect(reports).toContain("bridge ready"));
});
