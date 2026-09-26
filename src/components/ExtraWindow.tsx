import { useCallback, useEffect, useRef, useState } from "react";
import { Box, CircularProgress, GlobalStyles, IconButton, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import PauseOutlinedIcon from "@mui/icons-material/PauseOutlined";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { fontToStyle } from "../settings/DisplaySettingsContext";
import { useConfig } from "../settings/ConfigContext";
import { useImageDataUri } from "../hooks/useImageDataUri";
import type { ExtraWindowHistory, ExtraWindowText } from "../types/translation";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return "32, 32, 35";
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** 读取悬浮窗当前逻辑宽度并上报给主窗口持久化（下次打开恢复）。 */
async function reportExtraWindowWidth() {
  try {
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const sf = await win.scaleFactor();
    await emit("extra-window-size", { width: Math.round(size.width / sf) }).catch(() => {});
  } catch {
    // 忽略上报失败。
  }
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

/** 一次向主窗口请求的历史条数（滚轮上翻到已加载边界时按需加载）。 */
const HISTORY_BATCH = 50;
/** 悬浮窗本地保留的历史缓冲上限（含实时块），超出丢弃最旧的。 */
const MAX_HISTORY_BUFFER = 300;

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
  // 历史浏览：buffer 是该线程已加载的文本块（旧 → 新，含实时块），
  // cursor 指向当前显示的下标；滚轮上翻到边界时再向主窗口按需加载更早的历史。
  // 历史始终跟随主窗口选中的文本线程（payload.threadId），切换线程即重置。
  const [paused, setPaused] = useState(false);
  const [buffer, setBuffer] = useState<ExtraWindowText[]>([]);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bufferRef = useRef<ExtraWindowText[]>([]);
  const cursorRef = useRef(0);
  // 是否还有更早的历史可加载（首次请求前按“可能有”处理）。
  const hasMoreRef = useRef(true);
  const pendingHistoryRef = useRef(false);
  const historyThreadRef = useRef("");
  // 暂停时被“钉住”的那条（其 id）；恢复时若仍显示这条则自动回到最新。
  const pinnedIdRef = useRef<string | null>(null);

  const setBufferBoth = useCallback((next: ExtraWindowText[]) => {
    bufferRef.current = next;
    setBuffer(next);
  }, []);
  const setCursorBoth = useCallback((next: number) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  // 当前显示的条目：正在看最新时直接用实时载荷（保持“无输出”提示的原行为），
  // 浏览历史时用缓冲中对应的那一条。
  const tailIndex = buffer.length - 1;
  const clampedCursor = Math.min(Math.max(cursor, 0), Math.max(tailIndex, 0));
  /** 距最新一条的历史回退条数（0 = 正在看最新）。 */
  const backCount = buffer.length > 0 ? tailIndex - clampedCursor : 0;
  const view = backCount > 0 ? buffer[clampedCursor] : payload;
  const positionRestoredRef = useRef(false);
  const widthRestoredRef = useRef(false);
  const bgImage = useImageDataUri(settings.backgroundImage);

  // 实时文本（当前选中线程的最新一块）→ 维护本地历史缓冲。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExtraWindowText>("extra-window-text", (event) => {
      if (disposed) return;
      const block = event.payload;
      setPayload(block);
      if (historyThreadRef.current !== block.threadId) {
        // 切换线程：历史缓冲重置为当前线程（历史始终跟随选中线程）。
        historyThreadRef.current = block.threadId;
        pendingHistoryRef.current = false;
        hasMoreRef.current = true;
        pinnedIdRef.current = null;
        setTotal(0);
        setBufferBoth(block.original.trim() === "" ? [] : [block]);
        setCursorBoth(0);
        return;
      }
      // 该线程内已无文本块（全部被删除）→ 清空历史缓冲。
      if (block.id === "") {
        pendingHistoryRef.current = false;
        hasMoreRef.current = false;
        pinnedIdRef.current = null;
        setTotal(0);
        setBufferBoth([]);
        setCursorBoth(0);
        return;
      }
      if (block.original.trim() === "") return; // 空原文块不进入历史。
      const prev = bufferRef.current;
      if (prev.length === 0) {
        // 缓冲为空（首次或刚被清空）→ 以实时块重新起头，允许向上加载更早历史。
        hasMoreRef.current = true;
        setBufferBoth([block]);
        setCursorBoth(0);
        return;
      }
      const lastIndex = prev.length - 1;
      const atTail = cursorRef.current >= lastIndex;
      // 从暂停恢复时：若用户仍停在暂停那一刻的那条上（没手动翻过），则回到最新一条。
      // 返回 true 表示已经处理了光标（调用方无需再按“是否在尾部”决定）。
      const resumeToTail = () => {
        if (pinnedIdRef.current === null) return false;
        const pinned = pinnedIdRef.current;
        pinnedIdRef.current = null;
        if (bufferRef.current[cursorRef.current]?.id === pinned) {
          setCursorBoth(bufferRef.current.length - 1);
          return true;
        }
        return false;
      };
      if (prev.length >= 2 && prev[lastIndex - 1].id === block.id) {
        // 最新一块被删除：主窗口回退到前一块，这里同步丢弃缓冲尾部，避免重复。
        const next = prev.slice(0, lastIndex);
        setBufferBoth(next);
        setCursorBoth(atTail ? next.length - 1 : Math.min(cursorRef.current, next.length - 1));
        return;
      }
      if (prev[lastIndex].id === block.id) {
        // 同一块（如译文返回，或暂停期间新文本已经在缓冲里）→ 原地更新。
        const next = prev.slice();
        next[lastIndex] = block;
        setBufferBoth(next);
        if (!block.hold) resumeToTail();
        return;
      }
      const appended = [...prev, block];
      const overflow = Math.max(0, appended.length - MAX_HISTORY_BUFFER);
      // 暂停开始那一刻正在显示的条目（在截断之前取，避免溢出导致的索引偏移）。
      if (block.hold && pinnedIdRef.current === null) {
        pinnedIdRef.current = prev[cursorRef.current]?.id ?? "";
      }
      const next = overflow > 0 ? appended.slice(overflow) : appended;
      setBufferBoth(next);
      if (block.hold) {
        // 主窗口暂停中：只把新文本记进历史（避免恢复后历史出现空洞），
        // 但不切换显示 —— 继续显示暂停那一刻的那条。
        if (overflow > 0) setCursorBoth(Math.max(0, cursorRef.current - overflow));
        return;
      }
      if (resumeToTail()) return;
      if (atTail) setCursorBoth(next.length - 1);
      else if (overflow > 0) setCursorBoth(Math.max(0, cursorRef.current - overflow));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setBufferBoth, setCursorBoth]);

  // 主窗口里已有块的内容发生变化（在历史文本上手动翻译 / 重试 / 重新翻译、
  // 罗马音返回等）：刷新本地缓冲与实时载荷里对应的那一条。
  // 若该条还没被加载进缓冲（更早的历史），则忽略——之后按需加载时会取到最新值。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExtraWindowText>("extra-window-text-update", (event) => {
      if (disposed) return;
      const block = event.payload;
      if (block.threadId !== historyThreadRef.current) return;
      setPayload((prev) => (prev && prev.id === block.id ? block : prev));
      const index = bufferRef.current.findIndex((entry) => entry.id === block.id);
      if (index < 0) return;
      const next = bufferRef.current.slice();
      next[index] = block;
      setBufferBoth(next);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setBufferBoth]);

  // 主窗口返回的历史批次：前插到缓冲头部，光标移到紧邻当前位置之前的一条。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<ExtraWindowHistory>("extra-window-history", (event) => {
      if (disposed) return;
      const { threadId, total: count, hasMore, entries } = event.payload;
      if (threadId !== historyThreadRef.current) return; // 线程已切换，丢弃过期响应。
      pendingHistoryRef.current = false;
      hasMoreRef.current = hasMore;
      setTotal(count);
      if (entries.length === 0) return;
      setBufferBoth([...entries, ...bufferRef.current]);
      setCursorBoth(entries.length - 1);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setBufferBoth, setCursorBoth]);

  // 向主窗口按需加载更早的历史（以当前最旧一条的块 id 为锚点，新块到达不会错位）。
  const loadOlder = useCallback(() => {
    if (!isTauri() || pendingHistoryRef.current || !hasMoreRef.current) return;
    const oldest = bufferRef.current[0];
    if (!oldest) return;
    pendingHistoryRef.current = true;
    void emit("extra-window-history-request", {
      threadId: historyThreadRef.current,
      beforeId: oldest.id,
      limit: HISTORY_BATCH,
    }).catch(() => {
      pendingHistoryRef.current = false;
    });
  }, []);

  const stepOlder = useCallback(() => {
    if (cursorRef.current > 0) {
      setCursorBoth(cursorRef.current - 1);
      return;
    }
    loadOlder();
  }, [loadOlder, setCursorBoth]);

  const stepNewer = useCallback(() => {
    const next = cursorRef.current + 1;
    if (next <= bufferRef.current.length - 1) setCursorBoth(next);
  }, [setCursorBoth]);

  // 滚轮：上/下切换历史文本；Shift+滚轮滚动当前长文本（交给原生滚动）。
  // React 的 onWheel 是 passive 监听，无法 preventDefault，因此用原生监听。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || event.deltaY === 0) return;
      event.preventDefault();
      if (event.deltaY < 0) stepOlder();
      else stepNewer();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stepOlder, stepNewer]);

  // 暂停状态由主窗口广播（主窗口输出区与悬浮窗的暂停按钮共享同一状态）。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ paused: boolean }>("extra-window-paused", (event) => {
      if (!disposed) setPaused(event.payload.paused);
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
      tint: settings.effectTint || null,
      tintAlpha: settings.effectTintOpacity,
    }).catch(() => {});
  }, [settings.effect, settings.effectTint, settings.effectTintOpacity, isDark]);

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
  // 恢复可能发生在窗口尚未完全就绪时，失败则重试，避免一次性放弃后宽度变回默认值。
  useEffect(() => {
    if (!isTauri() || widthRestoredRef.current) return;
    const savedWidth = settings.width;
    if (!savedWidth) return;
    const win = getCurrentWindow();
    let attempts = 0;
    const tryRestore = async () => {
      try {
        const size = await win.innerSize();
        const sf = await win.scaleFactor();
        const logical = size.toLogical(sf);
        await win.setSize(new LogicalSize(savedWidth, logical.height));
        widthRestoredRef.current = true;
      } catch {
        attempts += 1;
        if (attempts < 10) {
          window.setTimeout(tryRestore, 200);
        }
      }
    };
    void tryRestore();
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
    void win
      .onResized(() => {
        if (disposed) return;
        if (timer !== undefined) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void reportExtraWindowWidth();
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

  // 跟随最新内容时滚动到底部；浏览历史时回到该条开头。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTail = cursorRef.current >= bufferRef.current.length - 1;
    el.scrollTop = atTail ? el.scrollHeight : 0;
  }, [view, cursor]);

  // 自动调整窗口高度以适配内容（按内容自然高度计算，避免每次都叠加）。
  // 翻译进行中（loading）暂不调整：等译文返回后再一次性调整，避免“先小后大”的跳动；
  // 并加轻微防抖合并快速连续的内容变化。
  useEffect(() => {
    if (!settings.autoResizeHeight || !isTauri()) return;
    const loading = view?.translations.some((e) => e.state === "loading") ?? false;
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
  }, [view, settings.autoResizeHeight]);

  const handleClose = () => {
    if (isTauri()) {
      void getCurrentWindow().hide().catch(() => {});
    }
  };

  // 切换暂停（主窗口输出区的暂停按钮同步显示同一状态）。
  const togglePause = () => {
    if (!isTauri()) return;
    void emit("extra-window-set-paused", { paused: !paused }).catch(() => {});
  };

  const startResize = (dir: ResizeDir) => {
    if (!isTauri()) return;
    // 拖拽结束（Promise resolve）时立即上报一次宽度，避免用户松手后很快退出
    // 应用，250ms 防抖还没触发导致宽度丢失。
    void getCurrentWindow()
      .startResizeDragging(dir)
      .then(() => reportExtraWindowWidth())
      .catch(() => {});
  };

  // 内容区域按住拖动 → 移动整个悬浮窗；但落在垂直滚动条上时交给原生滚动条
  // （clientWidth 不含滚动条宽度，故可据此区分），否则长文本的滚动条一拖就变成
  // 移动窗口。
  const handleContentMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isTauri() || event.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    if (event.clientX - el.getBoundingClientRect().left >= el.clientWidth) return;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  const translationFont = settings.sameForBoth ? settings.source : settings.translation;
  const defaultTint = isDark ? "#202023" : "#fafafc";
  const tintRgb = hexToRgb(settings.effectTint || defaultTint);
  // 原生效果（Aero/亚克力/云母）自带背景与 tint，Web 层只保留很淡的遮罩，
  // 避免高不透明度 + 夜间模式下叠加出与 Windows 原生不一致的颜色；
  // 遮罩颜色/强度由“tint 颜色 / tint 不透明度”控制。
  const tintAlpha = settings.effect === "none" ? settings.opacity : settings.effectTintOpacity * 0.2;
  const panelBg = `rgba(${tintRgb}, ${tintAlpha})`;

  const doneTranslations =
    view?.translations.filter((e) => e.state === "done" && e.text) ?? [];
  const loading = view?.translations.some((e) => e.state === "loading") ?? false;
  const errors = view?.translations.filter((e) => e.state === "error") ?? [];

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
        {view?.original}
      </Typography>
      {view?.romanji && (
        <Typography
          variant="body2"
          sx={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "text.secondary",
            ...fontToStyle(translationFont),
          }}
        >
          {view.romanji}
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
            onMouseDown={handleContentMouseDown}
            sx={{
              position: "relative",
              // 右侧留 6px，让滚动条避开边缘调宽手柄，否则滚动条尾部抓不住。
              width: "calc(100% - 6px)",
              height: "100%",
              overflowY: "auto",
              overflowX: "hidden",
              boxSizing: "border-box",
              px: 2,
              py: 2,
              // 内容层必须接收鼠标事件，否则事件穿透到下层拖动层，
              // 导致滚轮无法滚动、滚动条一拖就变成移动整个悬浮窗。
              // 注意：不要在这里写任何 `::-webkit-scrollbar` 样式 —— 一旦写了，
              // Chromium/WebView2 会改用自绘滚动条，未显式定义的 track/thumb 会
              // 变成完全看不见（滚动条“消失”）。
              pointerEvents: "auto",
              cursor: "move",
            }}
          >
            <Box ref={contentRef}>
            {!view || view.original.trim() === "" ? (
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

          {/* 浏览历史时的位置提示（-N = 距最新一条回退了 N 条，/T = 该线程总条数）。
              right 需避开右上角的暂停（right 40）与关闭（right 6）按钮。 */}
          {backCount > 0 && (
            <Box
              sx={{
                position: "absolute",
                top: 4,
                right: 74,
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                color: "text.secondary",
                opacity: 0.7,
              }}
            >
              <HistoryOutlinedIcon sx={{ fontSize: 14 }} />
              <Typography variant="caption">
                -{backCount}
                {total > 0 ? ` / ${total}` : ""}
              </Typography>
            </Box>
          )}
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
          onClick={togglePause}
          size="small"
          aria-label={paused ? t("content.resume") : t("content.pause")}
          sx={{
            position: "absolute",
            top: 6,
            right: 40,
            zIndex: 4,
            color: paused ? "warning.main" : "text.secondary",
            // 暂停时保持完整显示，便于一眼看出当前处于暂停状态。
            opacity: paused ? 1 : 0.35,
            "&:hover": { opacity: 1 },
          }}
        >
          {paused ? (
            <PlayArrowOutlinedIcon fontSize="small" />
          ) : (
            <PauseOutlinedIcon fontSize="small" />
          )}
        </IconButton>

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
