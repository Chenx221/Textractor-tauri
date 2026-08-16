import { useEffect, useRef, useState } from "react";
import { Box, CircularProgress, GlobalStyles, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { fontToStyle } from "../settings/DisplaySettingsContext";
import { useConfig } from "../settings/ConfigContext";
import { useImageDataUri } from "../hooks/useImageDataUri";
import type { ExtraWindowText } from "../types/translation";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

/**
 * 无边框悬浮窗（extra window）：显示当前查看线程的最新一条原文 / 译文。
 * 数据由主窗口通过 `extra-window-text` 事件转发而来；设置来自主配置的
 * `extraWindow`（主窗口修改后会通过 `config-changed` 事件同步过来）。
 */
export function ExtraWindowApp() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { config } = useConfig();
  const settings = config.extraWindow;
  const isDark = theme.palette.mode === "dark";
  const [payload, setPayload] = useState<ExtraWindowText | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const positionRestoredRef = useRef(false);
  const widthRestoredRef = useRef(false);
  const bgImage = useImageDataUri(settings.backgroundImage);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExtraWindowText>("extra-window-text", (event) => {
      if (!disposed) setPayload(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 原生背景效果（none/aero/acrylic/mica）跟随设置与主题。
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_window_effect", {
      label: "extra",
      effect: settings.effect,
      dark: isDark,
    }).catch(() => {});
  }, [settings.effect, isDark]);

  // 置顶 / 点击穿透跟随设置。
  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWindow().setAlwaysOnTop(settings.alwaysOnTop).catch(() => {});
  }, [settings.alwaysOnTop]);

  useEffect(() => {
    if (!isTauri()) return;
    void getCurrentWindow().setIgnoreCursorEvents(settings.clickThrough).catch(() => {});
  }, [settings.clickThrough]);

  // 悬浮窗不响应右键菜单。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // 恢复上次窗口位置（物理像素，做一次屏幕边界钳制避免跑到屏幕外）。
  // 依赖 settings.position：配置是异步加载的，等它可用后再恢复一次。
  useEffect(() => {
    if (!isTauri() || positionRestoredRef.current) return;
    const pos = settings.position;
    if (!pos) return;
    positionRestoredRef.current = true;
    const win = getCurrentWindow();
    void (async () => {
      try {
        const monitors = await availableMonitors();
        if (monitors.length === 0) return;
        const target =
          monitors.find(
            (m) =>
              pos.x >= m.position.x &&
              pos.x < m.position.x + m.size.width &&
              pos.y >= m.position.y &&
              pos.y < m.position.y + m.size.height,
          ) ?? monitors[0];
        const x = Math.max(
          target.position.x,
          Math.min(pos.x, target.position.x + target.size.width - 120),
        );
        const y = Math.max(
          target.position.y,
          Math.min(pos.y, target.position.y + target.size.height - 60),
        );
        await win.setPosition(new PhysicalPosition(x, y));
      } catch {
        // 忽略恢复失败。
      }
    })();
  }, [settings.position]);

  // 恢复上次窗口宽度（逻辑像素），高度保持当前值（autoResizeHeight 会自适应高度）。
  useEffect(() => {
    if (!isTauri() || widthRestoredRef.current) return;
    const savedWidth = settings.width;
    if (!savedWidth) return;
    widthRestoredRef.current = true;
    const win = getCurrentWindow();
    void (async () => {
      try {
        const size = await win.innerSize();
        const sf = await win.scaleFactor();
        const logical = size.toLogical(sf);
        await win.setSize(new LogicalSize(savedWidth, logical.height));
      } catch {
        // 忽略恢复失败。
      }
    })();
  }, [settings.width]);

  // 悬浮窗被拖动后，把位置上报给主窗口写入配置（下次打开恢复）。
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let timer: number | undefined;
    void win
      .onMoved(({ payload }) => {
        if (disposed) return;
        // 防抖：仅移动停止后上报一次。
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void emit("extra-window-position", { x: payload.x, y: payload.y }).catch(() => {});
        }, 250);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // 悬浮窗宽度变化后，防抖上报宽度给主窗口保存（下次打开恢复）。
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let timer: number | undefined;
    let lastWidth = 0;
    void win
      .onResized(({ payload }) => {
        if (disposed) return;
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(async () => {
          try {
            const sf = await win.scaleFactor();
            const logicalWidth = Math.round(payload.width / sf);
            if (logicalWidth === lastWidth) return;
            lastWidth = logicalWidth;
            await emit("extra-window-size", { width: logicalWidth }).catch(() => {});
          } catch {
            // 忽略。
          }
        }, 250);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);

  // 新内容到达时滚动到底部。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [payload]);

  // 自动调整窗口高度以适配内容（按内容自然高度计算，避免每次都叠加）。
  // 翻译进行中（loading）暂不调整：等译文返回后再一次性调整，避免“先小后大”的跳动；
  // 并加轻微防抖合并快速连续的内容变化。
  useEffect(() => {
    if (!settings.autoResizeHeight || !isTauri()) return;
    const loading = payload?.translations.some((e) => e.state === "loading") ?? false;
    if (loading) return;
    const timer = window.setTimeout(() => {
      const content = contentRef.current;
      if (!content) return;
      const win = getCurrentWindow();
      const target = Math.min(Math.max(content.offsetHeight + 32, 72), 800);
      void (async () => {
        try {
          const size = await win.innerSize();
          const sf = await win.scaleFactor();
          const logical = size.toLogical(sf);
          if (Math.abs(logical.height - target) < 2) return;
          await win.setSize(new LogicalSize(logical.width, target));
        } catch {
          // 忽略调整失败。
        }
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [payload, settings.autoResizeHeight]);

  const handleClose = () => {
    if (isTauri()) {
      void getCurrentWindow().hide().catch(() => {});
    }
  };

  const startResize = (dir: ResizeDir) => {
    if (!isTauri()) return;
    void getCurrentWindow().startResizeDragging(dir).catch(() => {});
  };

  const translationFont = settings.sameForBoth ? settings.source : settings.translation;
  const tint = isDark ? "32, 32, 35" : "250, 250, 252";
  // 原生效果（Aero/亚克力/云母）自带背景与 tint，Web 层只保留很淡的遮罩，
  // 避免高不透明度 + 夜间模式下叠加出与 Windows 原生不一致的颜色。
  const tintAlpha = settings.effect === "none" ? settings.opacity : settings.opacity * 0.12;
  const panelBg = `rgba(${tint}, ${tintAlpha})`;

  const doneTranslations =
    payload?.translations.filter((e) => e.state === "done" && e.text) ?? [];
  const loading = payload?.translations.some((e) => e.state === "loading") ?? false;
  const errors = payload?.translations.filter((e) => e.state === "error") ?? [];

  const renderOriginal = () => (
    <>
      {!settings.hideLabels && (
        <Typography variant="caption" sx={{ color: "text.secondary", userSelect: "none" }}>
          {t("content.original")}
        </Typography>
      )}
      <Typography
        variant="body1"
        sx={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...fontToStyle(settings.source),
        }}
      >
        {payload?.original}
      </Typography>
      {payload?.romanji && (
        <Typography
          variant="body2"
          sx={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "text.secondary",
            ...fontToStyle(translationFont),
          }}
        >
          {payload.romanji}
        </Typography>
      )}
    </>
  );

  const renderTranslations = () => (
    <>
      {!settings.hideLabels && doneTranslations.length > 0 && (
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", userSelect: "none", display: "block", mt: 1 }}
        >
          {t("content.translation")}
        </Typography>
      )}
      {doneTranslations.map((entry) => (
        <Box key={entry.provider} sx={{ mt: 0.5 }}>
          <Typography
            variant="body2"
            sx={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              ...fontToStyle(translationFont),
            }}
          >
            {entry.text}
          </Typography>
        </Box>
      ))}
      {loading && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
          <CircularProgress size={12} />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {t("content.translating")}
          </Typography>
        </Box>
      )}
      {errors.map((entry) => (
        <Typography
          key={entry.provider}
          variant="caption"
          sx={{ color: "error.main", display: "block", mt: 0.5 }}
        >
          {entry.error}
        </Typography>
      ))}
    </>
  );

  return (
    <>
      <GlobalStyles
        styles={{ "html, body": { background: "transparent", overflow: "hidden" } }}
      />
      <Box
        sx={{
          position: "relative",
          width: "100vw",
          height: "100vh",
          background: "transparent",
          overflow: "hidden",
        }}
      >
        {/* 整个窗口区域用于拖动（无边框窗口）。 */}
        <Box data-tauri-drag-region sx={{ position: "absolute", inset: 0, cursor: "move" }} />

        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            pointerEvents: "none",
            overflow: "hidden",
            background: panelBg,
          }}
        >
          {bgImage && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                backgroundImage: `url(${bgImage})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                opacity: settings.backgroundImageOpacity,
              }}
            />
          )}
          <Box
            ref={scrollRef}
            sx={{
              position: "relative",
              width: "100%",
              height: "100%",
              overflowY: "auto",
              boxSizing: "border-box",
              px: 2,
              py: 2,
            }}
          >
            <Box ref={contentRef}>
            {!payload || payload.original.trim() === "" ? (
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", ...fontToStyle(settings.source) }}
              >
                {t("content.noOutput")}
              </Typography>
            ) : settings.order === "originalFirst" ? (
              <>
                {settings.showOriginal && renderOriginal()}
                {settings.showTranslation && renderTranslations()}
              </>
            ) : (
              <>
                {settings.showTranslation && renderTranslations()}
                {settings.showOriginal && renderOriginal()}
              </>
            )}
            </Box>
          </Box>
        </Box>

        {/* 边缘调整大小手柄 */}
        <Box
          onMouseDown={() => startResize("North")}
          sx={{ position: "absolute", top: 0, left: 10, right: 10, height: 6, zIndex: 3, cursor: "ns-resize" }}
        />
        <Box
          onMouseDown={() => startResize("South")}
          sx={{ position: "absolute", bottom: 0, left: 10, right: 10, height: 6, zIndex: 3, cursor: "ns-resize" }}
        />
        <Box
          onMouseDown={() => startResize("West")}
          sx={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 6, zIndex: 3, cursor: "ew-resize" }}
        />
        <Box
          onMouseDown={() => startResize("East")}
          sx={{ position: "absolute", right: 0, top: 10, bottom: 10, width: 6, zIndex: 3, cursor: "ew-resize" }}
        />
        <Box
          onMouseDown={() => startResize("NorthWest")}
          sx={{ position: "absolute", top: 0, left: 0, width: 12, height: 12, zIndex: 3, cursor: "nwse-resize" }}
        />
        <Box
          onMouseDown={() => startResize("NorthEast")}
          sx={{ position: "absolute", top: 0, right: 0, width: 12, height: 12, zIndex: 3, cursor: "nesw-resize" }}
        />
        <Box
          onMouseDown={() => startResize("SouthWest")}
          sx={{ position: "absolute", bottom: 0, left: 0, width: 12, height: 12, zIndex: 3, cursor: "nesw-resize" }}
        />
        <Box
          onMouseDown={() => startResize("SouthEast")}
          sx={{ position: "absolute", bottom: 0, right: 0, width: 12, height: 12, zIndex: 3, cursor: "nwse-resize" }}
        />

        <IconButton
          onClick={handleClose}
          size="small"
          sx={{
            position: "absolute",
            top: 6,
            right: 6,
            zIndex: 4,
            color: "text.secondary",
            opacity: 0.35,
            "&:hover": { opacity: 1 },
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
    </>
  );
}
