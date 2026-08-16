import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ExtraWindowApp } from "./components/ExtraWindow";
import { ConfigProvider } from "./settings/ConfigContext";
import { ThemeModeProvider } from "./ThemeModeProvider";
import { HostProvider } from "./host/HostContext";
import "./i18n";

function currentWindowLabel(): string {
  if (!("__TAURI_INTERNALS__" in window)) return "main";
  return getCurrentWindow().label;
}

const isExtraWindow = currentWindowLabel() === "extra";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider>
      <ThemeModeProvider>
        {isExtraWindow ? (
          <ExtraWindowApp />
        ) : (
          <HostProvider>
            <App />
          </HostProvider>
        )}
      </ThemeModeProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
