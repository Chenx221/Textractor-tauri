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
import { BASE_BG } from "../theme";
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

/** 上一次上报过的宽度，避免"只是高度变了"也去写一次配置。 */
let lastReportedWidth = -1;

/** 读取悬浮窗当前逻辑宽度并上报给主窗口持久化（下次打开恢复）。 */
async function reportExtraWindowWidth() {
  try {
    const win = getCurrentWindow();
    const size = await win.innerSize();
    const sf = await win.scaleFactor();
    const width = Math.round(size.width / sf);
    // 自动高度每改一次高度都会触发 onResized；宽度没变就别重复写配置。
    if (width === lastReportedWidth) return;
    lastReportedWidth = width;
    await emit("extra-window-size", { width }).catch(() => {});
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
/** 自动高度：内容高度（含上下内边距）的裁剪范围。 */
const HEIGHT_MIN = 72;
const HEIGHT_MAX = 800;
/** 面板高度过渡时长，必须与下面的 CSS transition 保持一致。 */
const HEIGHT_TRANSITION_MS = 160;

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
      // 跟随主题时传 null，让原生层按深浅主题自己选色，避免和 Web 层的面板底色打架。
      tint: settings.tintFollowTheme ? null : settings.effectTint || null,
      tintAlpha: settings.effectTintOpacity,
    }).catch(() => {});
  }, [
    settings.effect,
    settings.effectTint,
    settings.tintFollowTheme,
    settings.effectTintOpacity,
    isDark,
  ]);

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
  //
  // 只有"内容已经顶到高度上限"时才贴底：那时窗口不能再长，必须让最新一行可见。
  // 没到上限时**保持贴顶**，这样长高的过程中顶部原文/注音不动、译文从下面
  // 一条条露出来 —— 而不是先把内容往上挤、再整体回弹。
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atTail = cursorRef.current >= bufferRef.current.length - 1;
    // scrollHeight 已经含上下内边距，所以直接和上限比。
    const atCap = el.scrollHeight >= HEIGHT_MAX;
    el.scrollTop = atTail && atCap ? el.scrollHeight : 0;
  }, [view, cursor]);

  // ---------------------------------------------------------- 自动高度 ----
  //
  // 关键点：**窗口尺寸的每一次变化都是"跳"的，动画交给 CSS**。
  //
  // 之前是逐帧 setSize 做补间，问题有三：
  // 1. 每一帧都跨进程调用一次 SetWindowPos，WebView2 的重绘追不上窗口变化，
  //    看起来就是一顿一顿的；
  // 2. 长文本撑破当前高度时，贴底滚动会让"原文/注音"被挤出视线，等窗口长高
  //    再把文字拉回来，于是出现"内容先往上挤、再展开"的怪异动作；
  // 3. 顶部没有真正的锚点 —— 窗口长高时内容是跟着滚动的，不是"顶部固定、底部延申"。
  //
  // 现在：
  // - 窗口高度一次性设成目标值（多出来的区域是透明的，看不见）；
  // - 面板自己的 height 用 CSS transition 从旧值长到新值，内容被面板裁切，
  //   于是视觉上就是"顶部原文/注音不动，底部一条条把译文露出来"；
  // - 收缩时先让面板缩完，再把窗口收小（否则面板会被窗口裁掉，看起来是瞬缩）。
  /** 面板自身的像素高度；null = 还没测量过，先用 100% 铺满窗口。 */
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const panelHeightRef = useRef(0);
  const sizeRef = useRef({ width: 0, height: 0 });
  const shrinkTimerRef = useRef(0);
  const targetRef = useRef(0);

  /** 把原生窗口高度设成 h（宽度保持不变）。 */
  const setWindowHeight = useCallback(async (h: number) => {
    if (!isTauri()) return;
    try {
      const win = getCurrentWindow();
      let width = sizeRef.current.width;
      if (!width) {
        const size = await win.innerSize();
        const sf = await win.scaleFactor();
        const logical = size.toLogical(sf);
        width = logical.width;
        sizeRef.current = { width, height: logical.height };
      }
      await win.setSize(new LogicalSize(width, h));
      sizeRef.current = { width, height: h };
    } catch {
      // 忽略调整失败。
    }
  }, []);

  /** 把面板/窗口高度调整到 target。 */
  const applyHeight = useCallback(
    (target: number) => {
      const to = Math.round(target);
      if (to === targetRef.current) return;
      targetRef.current = to;
      window.clearTimeout(shrinkTimerRef.current);

      const from = panelHeightRef.current;
      panelHeightRef.current = to;
      setPanelHeight(to);

      // 首次测量（from = 0）直接对齐，不做动画。
      if (from === 0) {
        void setWindowHeight(to);
        return;
      }
      if (to > from) {
        // 先扩窗口（透明区域看不见），面板再 CSS 过渡长上去 → 顶部固定、底部延申。
        void setWindowHeight(to);
      } else if (to < from) {
        // 收缩：等面板过渡结束再收窗口，否则窗口先把面板裁掉，看起来是瞬缩。
        shrinkTimerRef.current = window.setTimeout(() => {
          if (targetRef.current !== to) return;
          void setWindowHeight(to);
        }, HEIGHT_TRANSITION_MS + 60);
      }
    },
    [setWindowHeight],
  );

  // 记录窗口实际宽度（我们只改高度，但用户会拖边改宽）。
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const sync = async () => {
      try {
        const size = await win.innerSize();
        const sf = await win.scaleFactor();
        const logical = size.toLogical(sf);
        if (!disposed) sizeRef.current = { width: logical.width, height: logical.height };
      } catch {
        // 忽略。
      }
    };
    void sync();
    void win.onResized(() => void sync()).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      window.clearTimeout(shrinkTimerRef.current);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!settings.autoResizeHeight) return;
    const content = contentRef.current;
    if (!content) return;
    let timer = 0;
    const measure = () => {
      window.clearTimeout(timer);
      // 60ms 防抖：3 条译文几乎同时返回时只做一次调整。
      timer = window.setTimeout(() => {
        // 上下各 16px 内边距（scroll 容器 py: 2）。
        const raw = content.offsetHeight + 32;
        applyHeight(Math.min(Math.max(raw, HEIGHT_MIN), HEIGHT_MAX));
      }, 60);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    // 重新显示时补一次（隐藏期间布局可能没更新）。
    const onVisible = () => {
      if (document.hidden) return;
      // 强制重算一次：期间窗口可能被手动改过尺寸。
      targetRef.current = 0;
      panelHeightRef.current = 0;
      measure();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [settings.autoResizeHeight, applyHeight]);

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
  // 主题文字色：用户没单独指定颜色时用它（深色主题下就是浅色字），
  // 不依赖祖先元素继承 —— 透明窗口里继承链断掉会退回浏览器默认的黑色。
  const textColor = theme.palette.text.primary;
  /**
   * 面板底色。
   *
   * `effect: none` 时面板底色完全由 tint 决定，而 tint 的输入框以前只在"有原生效果"
   * 时才显示 —— 一旦存过 `#ffffff`，深色主题下面板还是白的，界面上还改不掉。
   * 现在默认跟随主题（深色主题 = 暗底），取消"跟随主题"后才使用自定义颜色。
   */
  const defaultTint = isDark ? BASE_BG.dark.default : BASE_BG.light.default;
  const tintHex = settings.tintFollowTheme
    ? defaultTint
    : settings.effectTint || defaultTint;
  const tintRgb = hexToRgb(tintHex);
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
          ...fontToStyle(settings.source, textColor),
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
            // 注音与正文同色（以前这里的 secondary 会被 fontToStyle 里的空 color 覆盖，
            // 实际一直是正文色；显式写成正文色，避免看起来"变暗"）。
            ...fontToStyle(translationFont, textColor),
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
              ...fontToStyle(translationFont, textColor),
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
        styles={{
          // 让滚动条/选中色也跟着主题走（WebView2 按 color-scheme 画原生滚动条）。
          html: { colorScheme: isDark ? "dark" : "light" },
          body: { background: "transparent", overflow: "hidden" },
        }}
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
            top: 0,
            left: 0,
            right: 0,
            zIndex: 1,
            pointerEvents: "none",
            overflow: "hidden",
            background: panelBg,
            // 圆角由这里画（透明窗口，窗口外圈是透明的，圆角就是把面板自己裁圆）。
            // 系统圆角只在开了 mica/亚克力时才启用（见 windowfx.rs），半径保持一致。
            borderRadius: "8px",
            // 自动高度：面板用自己的像素高度 + CSS 过渡。窗口已经先跳到目标高度
            // （多出来的区域透明、看不见），所以视觉上只有面板在平滑长高/收缩，
            // 顶部固定、底部延申。手动调高时直接铺满窗口。
            height:
              settings.autoResizeHeight && panelHeight !== null
                ? `${panelHeight}px`
                : "100%",
            transition: settings.autoResizeHeight
              ? `height ${HEIGHT_TRANSITION_MS}ms cubic-bezier(0.33, 0, 0.2, 1)`
              : "none",
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
              // 始终为滚动条预留空间：否则"内容刚好放得下 ↔ 出现滚动条"会让
              // 文本宽度来回变化（多折行 → 目标高度再变），自动高度会反复抖动。
              scrollbarGutter: "stable",
              // 内容层必须接收鼠标事件，否则事件穿透到下层拖动层，
              // 导致滚轮无法滚动、滚动条一拖就变成移动整个悬浮窗。
              // 注意：不要在这里写任何 `::-webkit-scrollbar` 样式 —— 一旦写了，
              // Chromium/WebView2 会改用自绘滚动条，未显式定义的 track/thumb 会
              // 变成完全看不见（滚动条“消失”）。
              pointerEvents: "auto",
              cursor: "move",
            }}
          >
            <Box ref={contentRef} sx={{ color: textColor }}>
            {!view || view.original.trim() === "" ? (
              <Typography
                variant="body2"
                sx={{ ...fontToStyle(settings.source, theme.palette.text.secondary) }}
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
