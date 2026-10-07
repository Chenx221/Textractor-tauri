import { useEffect, useState } from "react";
import { Alert, Box, Button, IconButton, Snackbar } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
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
import { checkForUpdateVersion } from "./hooks/useUpdater";
import { checkTexthookSilently } from "./hooks/useTexthook";
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
  const {
    attach,
    detach,
    saveHooks,
    insertHook,
    removeHook,
    findHooks,
    targets,
    targetPid,
    setTargetPid,
  } = useHost();
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
  const [snackbarMessage, setSnackbarMessage] = useState("");
  /** 启动时后台检查到的新版本（应用本体优先，其次 texthook 组件；非空则弹提示）。 */
  const [updateNotice, setUpdateNotice] = useState<{ kind: "app" | "texthook"; version: string } | null>(
    null,
  );

  // 启动后台静默检查更新：只在发现新版本时提示，不打扰用户（不阻塞任何启动流程）。
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        // 应用本体更新更重要，有就先报它。
        const appVersion = await checkForUpdateVersion();
        if (disposed) return;
        if (appVersion) {
          setUpdateNotice({ kind: "app", version: appVersion });
          return;
        }
        // texthook 组件更新（带 24h 节流，走缓存时不联网）。
        const texthookVersion = await checkTexthookSilently();
        if (!disposed && texthookVersion) {
          setUpdateNotice({ kind: "texthook", version: texthookVersion });
        }
      })();
    }, 4000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke<SystemInfo>("get_system_info")
      .then(setSystemInfo)
      .catch(() => {});
  }, []);

  // 目标进程列表与“当前目标”统一由 HostProvider 维护（多目标附加、断开后
  // 自动切到剩余目标、窗口重载后的同步都在那里），App 只负责按当前目标派发操作。

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
    setAttachOpen(false);
    // 附加成功的进程会由 HostProvider 登记为目标并自动设为当前目标。
    attach(process.pid);
    setSnackbarMessage(t("attach.attachedTo", { name: process.name, pid: process.pid }));
  };

  const handleDetach = () => {
    if (targetPid !== null) detach(targetPid);
  };

  const handleSaveHooks = () => {
    if (targetPid !== null) saveHooks(targetPid);
  };

  const handleConfigure = () => {
    if (targetPid === null) return;
    void invoke("configure_game", { pid: targetPid }).catch(() => {});
  };

  const handleForget = () => {
    if (targetPid === null) return;
    const name = targets.find((p) => p.pid === targetPid)?.name ?? `PID ${targetPid}`;
    // forget_game 会同时 detach，目标列表由断连事件自动更新。
    void invoke("forget_game", { pid: targetPid }).catch(() => {});
    setSnackbarMessage(t("attach.forgot", { name }));
  };

  const handleAddHook = (code: string) => {
    if (targetPid !== null) insertHook(targetPid, code);
  };

  const handleRemoveHook = (address: number) => {
    if (targetPid !== null) removeHook(targetPid, address);
  };

  const handleSearchHooksSubmit = (param: SearchParam) => {
    if (targetPid === null) return;
    findHooks(targetPid, param);
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
        targets={targets}
        targetPid={targetPid}
        onSelectTarget={setTargetPid}
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
        attachedPids={targets.map((process) => process.pid)}
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
        pid={targetPid}
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
        pid={targetPid}
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
      <Snackbar
        open={updateNotice !== null}
        autoHideDuration={12000}
        onClose={() => setUpdateNotice(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        message={
          updateNotice
            ? t(
                updateNotice.kind === "app"
                  ? "about.update.available"
                  : "about.texthook.available",
                { version: updateNotice.version },
              )
            : ""
        }
        action={
          <>
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                setUpdateNotice(null);
                setAboutOpen(true);
              }}
            >
              {t("about.update.open")}
            </Button>
            <IconButton
              size="small"
              color="inherit"
              aria-label={t("settings.close")}
              onClick={() => setUpdateNotice(null)}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </>
        }
      />
    </Box>
  );
}
