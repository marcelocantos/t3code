import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ManagedPolicyDocument } from "@t3tools/contracts";

import { corporatePolicy } from "./corporatePolicy.ts";

describe("corporate policy floor", () => {
  it.each(
    ([undefined, ["desktop"], ["local-browser"], ["desktop", "remote"]] as const).map(
      (clients) => ({ clients }),
    ),
  )(
    "preserves local client restrictions while refusing remote and cloud capabilities ($clients)",
    ({ clients }) => {
      const document = {
        schemaVersion: 1,
        organization: "Example Corp",
        settings: {
          defaultRuntimeMode: { value: "approval-required", locked: true },
          enableProviderUpdateChecks: { value: true, locked: false },
          "observability.otlpTracesUrl": { value: "https://collector.example.com", locked: false },
        },
        limits: {
          providers: { allowedDrivers: [ProviderDriverKind.make("codex")] },
          ...(clients === undefined ? {} : { clients }),
          connect: true,
          telemetry: true,
          webhookTasks: true,
          previewTunnel: true,
          updates: { mode: "auto", feedUrl: "https://updates.example.com", allowNightly: true },
        },
      } satisfies ManagedPolicyDocument;
      const result = corporatePolicy(document);
      expect(result._tag).toBe("Valid");
      if (result._tag !== "Valid") throw new Error("Local policy was refused");
      expect(result.document.limits).toEqual({
        clients: clients?.filter((client) => client !== "remote") ?? ["desktop", "local-browser"],
        connect: false,
        telemetry: false,
        webhookTasks: false,
        previewTunnel: false,
        updates: { mode: "off", allowNightly: false },
        providers: document.limits.providers,
      });
      expect(result.document.organization).toBe(document.organization);
      expect(result.document.settings).toEqual({
        defaultRuntimeMode: document.settings.defaultRuntimeMode,
        enableProviderUpdateChecks: { value: false, locked: true },
        observability: {
          value: { otlpTracesUrl: "", otlpMetricsUrl: "", otlpLogsUrl: "" },
          locked: true,
        },
      });
      expect(result.document.limits?.providers).toEqual(document.limits.providers);
      expect(document.limits.connect).toBe(true);
    },
  );

  it("refuses an administrator policy that permits no local client", () => {
    expect(
      corporatePolicy({
        schemaVersion: 1,
        organization: "Remote only",
        limits: { clients: ["remote"] },
      })._tag,
    ).toBe("Invalid");
  });

  it("enforces the floor without an installed administrator policy", () => {
    const result = corporatePolicy();
    expect(result._tag).toBe("Valid");
    if (result._tag !== "Valid") throw new Error("Default corporate policy was refused");
    expect(result.document.limits?.clients).toEqual(["desktop", "local-browser"]);
    expect(result.document.limits?.telemetry).toBe(false);
    expect(result.document.limits?.connect).toBe(false);
    expect(result.document.limits?.updates?.mode).toBe("off");
  });
});
