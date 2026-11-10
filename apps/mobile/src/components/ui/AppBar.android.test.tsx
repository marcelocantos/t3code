import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const workspace = vi.hoisted(() => ({ present: false }));

vi.mock("react-native", () => ({
  View: (props: { readonly children?: ReactNode }) => <div>{props.children}</div>,
  Keyboard: { dismiss: () => {} },
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
}));
// React Navigation throws this outside a navigator, as for the Arrange threads sheet.
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => {
    throw new Error("Couldn't find a navigation object.");
  },
}));
vi.mock("./AndroidScreenHeader.android", () => ({
  AndroidScreenHeader: (props: { readonly title: string }) => <h1>{props.title}</h1>,
}));
vi.mock("./WorkspaceAppBar.android", () => ({
  useHasWorkspaceAppBar: () => workspace.present,
  WorkspaceAppBar: () => null,
}));
vi.mock("./Menu", () => ({ Menu: (props: { readonly children?: ReactNode }) => props.children }));
vi.mock("./ScreenHeaderButton.android", () => ({ ScreenHeaderButton: () => null }));
vi.mock("./SearchField", () => ({ SearchField: () => null }));
vi.mock("./Button", () => ({ Button: () => null }));
vi.mock("../../features/layout/adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./useToolbarLayout", () => ({
  useToolbarLayout: () => ({ height: 48, paddingTop: 0, paddingBottom: 0 }),
}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../features/layout/useSidebarToggle", () => ({ useSidebarToggle: () => null }));
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { AppBar } from "./AppBar.android";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

it("renders a sheet bar without search outside a navigation container", () => {
  workspace.present = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Arrange threads" />));

  expect(container.textContent).toBe("Arrange threads");
});

it("keeps a sheet's title in the sheet when the sheet opens inside the workspace", () => {
  workspace.present = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => root.render(<AppBar sheet title="Counter details" />));

  expect(container.textContent).toBe("Counter details");
});
