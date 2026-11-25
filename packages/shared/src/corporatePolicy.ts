import type { ManagedPolicyDocument } from "@t3tools/contracts";

export function corporatePolicy(document?: ManagedPolicyDocument) {
  const clients = (document?.limits?.clients ?? (["desktop", "local-browser"] as const)).filter(
    (client) => client !== "remote",
  );
  const [first, ...rest] = clients;
  if (first === undefined) {
    return {
      _tag: "Invalid" as const,
      reason: "The corporate build requires at least one local client in the managed policy.",
    };
  }
  return {
    _tag: "Valid" as const,
    document: {
      schemaVersion: 1,
      organization: "Corporate edition",
      ...document,
      limits: {
        ...document?.limits,
        clients: [first, ...rest] as const,
        connect: false,
        telemetry: false,
        webhookTasks: false,
        previewTunnel: false,
        updates: { mode: "off", allowNightly: false },
      },
    } satisfies ManagedPolicyDocument,
  };
}
