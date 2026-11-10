import type { EnvironmentId, PluginPanel } from "@t3tools/contracts";
import { WebView } from "react-native-webview";
import { View } from "react-native";
import { usePreparedConnection } from "../../state/session";

export function PluginWebPanel({
  environmentId,
  panel,
  height,
}: {
  environmentId: EnvironmentId;
  panel: Extract<PluginPanel, { kind: "web" }>;
  height: number;
}) {
  const connection = usePreparedConnection(environmentId);
  if (connection._tag === "None") return null;
  const url = new URL(panel.path, connection.value.httpBaseUrl).href;
  const attribute = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style><iframe title="Plugin" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="${attribute}"></iframe>`;
  return (
    <View style={{ height }}>
      <WebView
        source={{ html, baseUrl: connection.value.httpBaseUrl }}
        originWhitelist={["*"]}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" ||
          request.url === connection.value.httpBaseUrl ||
          request.url.startsWith(url)
        }
        style={{ flex: 1 }}
      />
    </View>
  );
}
