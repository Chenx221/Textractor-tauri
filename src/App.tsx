import { useEffect, useState } from "react";
import { Alert, Box, Snackbar } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { ConsolePanel } from "./components/ConsolePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ExtensionsDialog } from "./components/ExtensionsDialog";
import { AboutDialog } from "./components/AboutDialog";
import { AttachDialog } from "./components/AttachDialog";
import { LaunchDialog } from "./components/LaunchDialog";
import { AddHookDialog } from "./components/AddHookDialog";
import { RemoveHookDialog } from "./components/RemoveHookDialog";
import { SearchHooksDialog } from "./components/SearchHooksDialog";
import { SearchResultsDialog } from "./components/SearchResultsDialog";
import { useHost, type SearchParam } from "./host/HostContext";
import { useConfig } from "./settings/ConfigContext";
import { useImageDataUri } from "./hooks/useImageDataUri";
import type { ProcessInfo } from "./types/process";

interface SystemInfo {
  is_admin: boolean;
  bitness: string;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export default function App() {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const { attach, detach, saveHooks, insertHook, removeHook, findHooks, clearSearchResults } =
    useHost();
  const { config } = useConfig();
  const mainBgImage = useImageDataUri(config.window.backgroundImage);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [addHookOpen, setAddHookOpen] = useState(false);
  const [removeHookOpen, setRemoveHookOpen] = useState(false);
  const [searchHooksOpen, setSearchHooksOpen] = useState(false);
  const [searchResultsOpen, setSearchResultsOpen] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [attachedProcess, setAttachedProcess] = useState<ProcessInfo | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<SystemInfo>("get_system_info")
      .then(setSystemInfo)
      .catch(() => {});
  }, []);

  // 进程断开（detach 或目标进程退出）时清除对应的 attach 状态。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<number>("host-disconnected", (event) => {
      if (disposed) return;
      setAttachedProcess((prev) => (prev && prev.pid === event.payload ? null : prev));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 进程连接（含启动时 auto_attach）时同步 UI 的 attach 状态。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<number>("host-connected", (event) => {
      if (disposed) return;
      void invoke<ProcessInfo[]>("list_processes")
        .then((list) => {
          const process = list.find((p) => p.pid === event.payload);
          if (process) setAttachedProcess(process);
        })
        .catch(() => {});
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !systemInfo) return;
    const bits =
      systemInfo.bitness === "32" ? t("titlebar.bits32") : t("titlebar.bits64");
    const title = systemInfo.is_admin
      ? `${t("app.title")} (${bits}) · ${t("titlebar.admin")}`
      : `${t("app.title")} (${bits})`;
    document.title = title;
    void getCurrentWindow().setTitle(title).catch((e) => console.error("setTitle failed", e));
  }, [systemInfo, t, i18n.language]);

  // 主窗口原生背景效果（none/aero/acrylic/mica）跟随设置与主题。
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_window_effect", {
      label: "main",
      effect: config.window.effect,
      dark: theme.palette.mode === "dark",
      tint: config.window.effectTint || null,
      tintAlpha: config.window.effectTintOpacity,
    }).catch(() => {});
  }, [config.window.effect, config.window.effectTint, config.window.effectTintOpacity, theme.palette.mode]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const isDevtoolsShortcut =
        event.key === "F12" ||
        (event.ctrlKey && event.shiftKey && (key === "c" || key === "k" || key === "i"));
      if (import.meta.env.DEV) {
        // debug 构建：F12 打开开发者工具。
        if (event.key === "F12") {
          event.preventDefault();
          if (isTauri()) {
            void invoke("open_devtools").catch(() => {});
          }
        }
        return;
      }
      // release 构建：屏蔽开发者工具快捷键，仅保留彩蛋（About 页 logo 点 5 次）。
      if (isDevtoolsShortcut) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleRestartAsAdmin = () => {
    if (!isTauri() || import.meta.env.DEV) {
      setSnackbarMessage(t("titlebar.restartUnavailable"));
      return;
    }
    void invoke("restart_as_admin").catch(() => {
      setSnackbarMessage(t("titlebar.restartUnavailable"));
    });
  };

  const handleToggleExtraWindow = () => {
    if (!isTauri()) {
      setSnackbarMessage(t("extraWindow.unavailable"));
      return;
    }
    void invoke<boolean>("toggle_extra_window").catch(() => {
      setSnackbarMessage(t("extraWindow.unavailable"));
    });
  };

  const handleAttach = (process: ProcessInfo) => {
    setAttachedProcess(process);
    setAttachOpen(false);
    attach(process.pid);
    setSnackbarMessage(t("attach.attachedTo", { name: process.name, pid: process.pid }));
  };

  const handleDetach = () => {
    if (attachedProcess) detach(attachedProcess.pid);
  };

  const handleSaveHooks = () => {
    if (attachedProcess) saveHooks(attachedProcess.pid);
  };

  const handleConfigure = () => {
    if (!attachedProcess) return;
    void invoke("configure_game", { pid: attachedProcess.pid }).catch(() => {});
  };

  const handleForget = () => {
    if (!attachedProcess) return;
    void invoke("forget_game", { pid: attachedProcess.pid }).catch(() => {});
    setAttachedProcess(null);
    setSnackbarMessage(t("attach.forgot", { name: attachedProcess.name }));
  };

  const handleAddHook = (code: string) => {
    if (attachedProcess) insertHook(attachedProcess.pid, code);
  };

  const handleRemoveHook = (address: number) => {
    if (attachedProcess) removeHook(attachedProcess.pid, address);
  };

  const handleSearchHooksSubmit = (param: SearchParam) => {
    if (!attachedProcess) return;
    clearSearchResults();
    findHooks(attachedProcess.pid, param);
    setSearchResultsOpen(true);
  };

  return (
    <Box
      sx={{
        position: "relative",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
      }}
    >
      {mainBgImage && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            backgroundImage: `url(${mainBgImage})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            opacity: config.window.backgroundImageOpacity,
          }}
        />
      )}
      <Box
        sx={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          height: "100%",
          width: "100%",
          overflow: "hidden",
          bgcolor: "background.default",
        }}
      >
      <Sidebar
        onDetach={handleDetach}
        onSaveHooks={handleSaveHooks}
        onConfigure={handleConfigure}
        onForget={handleForget}
        onAddHook={() => setAddHookOpen(true)}
        onRemoveHook={() => setRemoveHookOpen(true)}
        onSearchHooks={() => setSearchHooksOpen(true)}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((prev) => !prev)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenExtensions={() => setExtensionsOpen(true)}
        onOpenAttach={() => setAttachOpen(true)}
        onOpenLaunch={() => setLaunchOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onToggleExtraWindow={handleToggleExtraWindow}
        onRestartAsAdmin={handleRestartAsAdmin}
        isAdmin={systemInfo?.is_admin ?? null}
        attachedProcess={attachedProcess}
      />
      <Box component="main" sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <ConsolePanel />
      </Box>
      </Box>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ExtensionsDialog open={extensionsOpen} onClose={() => setExtensionsOpen(false)} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <AttachDialog
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onAttach={handleAttach}
      />
      <LaunchDialog
        open={launchOpen}
        onClose={() => setLaunchOpen(false)}
        onLaunched={(path) => setSnackbarMessage(t("launch.launched", { path }))}
      />
      <AddHookDialog
        open={addHookOpen}
        onClose={() => setAddHookOpen(false)}
        onSubmit={handleAddHook}
      />
      <RemoveHookDialog
        open={removeHookOpen}
        pid={attachedProcess?.pid ?? null}
        onClose={() => setRemoveHookOpen(false)}
        onRemove={handleRemoveHook}
      />
      <SearchHooksDialog
        open={searchHooksOpen}
        onClose={() => setSearchHooksOpen(false)}
        onSubmit={handleSearchHooksSubmit}
      />
      <SearchResultsDialog
        open={searchResultsOpen}
        pid={attachedProcess?.pid ?? null}
        onClose={() => setSearchResultsOpen(false)}
      />
      <Snackbar
        open={snackbarMessage !== ""}
        autoHideDuration={4000}
        onClose={() => setSnackbarMessage("")}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" variant="filled" onClose={() => setSnackbarMessage("")}>
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
}
