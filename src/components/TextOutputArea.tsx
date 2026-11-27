import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Fab, Tooltip, Typography } from "@mui/material";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import PauseOutlinedIcon from "@mui/icons-material/PauseOutlined";
import PlayArrowOutlinedIcon from "@mui/icons-material/PlayArrowOutlined";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useExtensions } from "../extensions/ExtensionsContext";
import { useHost } from "../host/HostContext";
import { TranslationBlock } from "./TranslationBlock";
import type { TextBlock } from "../types/translation";

interface TextOutputAreaProps {
  blocks: TextBlock[];
  onDelete: (id: string) => void;
}

/** 从 DOM 节点往上找所属文本块的索引（容器上写了 `data-index`）。 */
function blockIndexFromNode(node: Node | null): number | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    const raw = (el as HTMLElement).dataset?.index;
    if (raw !== undefined) {
      const index = Number(raw);
      return Number.isFinite(index) ? index : null;
    }
    el = el.parentElement;
  }
  return null;
}

/** 单个文本块 → 纯文本（与块内"复制原文+译文"按钮保持一致的排版）。 */
function blockToText(block: TextBlock): string {
  const done = block.translations
    .filter((entry) => entry.state === "done" && entry.text)
    .map((entry) => entry.text);
  return done.length > 0 ? `${block.original}\n\n${done.join("\n")}` : block.original;
}

export function TextOutputArea({ blocks, onDelete }: TextOutputAreaProps) {
  const { t } = useTranslation();
  const { hasEnabledTranslationProvider } = useExtensions();
  const { translateBlock, retryBlock, retranslateBlock, paused, setPaused } = useHost();
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastScrollTopRef = useRef(0);
  // 标记用户是否正在主动滚动（滚轮 / 触摸 / 拖动滚动条 / 键盘翻页）。
  // 库内部的程序化滚动与浏览器对 scrollTop 的 clamp 纠正不会经过这些输入，
  // 因此不会把自动跟随造成的 scrollTop 回调误判成“用户上滑”而误关自动滚动。
  const userScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<number | undefined>(undefined);

  // 虚拟滚动：只渲染可视区域附近的文本块，避免单个线程积累上千块时
  // 切换线程需要一次性挂载/布局全部 DOM 造成的卡顿。
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 96,
    gap: 8,
    overscan: 10,
    getItemKey: (index) => blocks[index]?.id ?? index,
    // 注意：不启用 followOnAppend / anchorTo。这两个选项在“贴底 + 大量动态
    // 高度块频繁测量”时，内置滚动补偿会把内部 scrollOffset 推到超过真实内容
    // 范围（内部值与 DOM scrollTop 脱节），导致视口里一个块都渲染不出来——
    // 页面突然全白，往上滚一下才恢复，且自动下翻随之失效。
    // 自动滚动改为下方 useEffect 直接设置 scrollTop（轻量、无协调循环）。
  });

  // getTotalSize() 随虚拟列表的测量结果变化（组件内调用是响应式的），
  // 作为内部滚动容器高度即可随测量结果自动增长，滚动条也随之准确。
  const totalSize = virtualizer.getTotalSize();

  const markUserScroll = () => {
    userScrollingRef.current = true;
    window.clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = window.setTimeout(() => {
      userScrollingRef.current = false;
    }, 600);
  };

  useEffect(() => () => window.clearTimeout(userScrollTimerRef.current), []);

  // ---- 跨块复制的兜底 ----
  // 虚拟滚动只挂载可视区附近的块：从头一路拖选滚到底部时，上面那些块的 DOM
  // 早已卸载（或整块被复用），浏览器只能复制到最后一个还挂载的小片段。
  // 这里在 copy 事件里判断选区是否跨越了"未挂载"的块，是的话直接按数据模型
  // 重建整段文本，保证复制到的内容与看到的一致。
  const selectionAnchorRef = useRef<number | null>(null);

  const handleCopy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const container = parentRef.current;
    if (!container) return;
    const range = selection.getRangeAt(0);
    // Ctrl+A 之类"选中整个列表"：AnchorNode 是容器本身，没有 data-index。
    const selectAll = selection.containsNode(container, true);
    const mounted = new Set(virtualizer.getVirtualItems().map((item) => item.index));

    const liveStart = selectAll ? 0 : blockIndexFromNode(range.startContainer);
    const liveEnd = selectAll ? blocks.length - 1 : blockIndexFromNode(range.endContainer);
    if (liveEnd === null) return;

    let start = liveStart;
    const anchor = selectionAnchorRef.current;
    if (!selectAll && anchor !== null) {
      if (start === null) {
        // 起点的 DOM 整个没了（拖到底部后顶部块被卸载）。
        start = anchor;
      } else if (!mounted.has(anchor) && anchor < start) {
        // 起点被虚拟滚动卸掉后，浏览器会把选区截断到第一个还挂载的块；
        // 用 mousedown 时记下的真实起点还原。
        start = anchor;
      }
    }
    if (start === null) return;

    const from = Math.max(0, Math.min(start, liveEnd));
    const to = Math.min(blocks.length - 1, Math.max(start, liveEnd));
    if (to <= from) return; // 单块：交给浏览器默认行为，保留块内的精确选择

    // 区间内的块全都还挂载着 → 浏览器自己就复制得对，不要干预。
    for (let i = from; i <= to; i += 1) {
      if (mounted.has(i)) continue;
      event.preventDefault();
      event.clipboardData.setData(
        "text/plain",
        blocks.slice(from, to + 1).map(blockToText).join("\n\n"),
      );
      return;
    }
  };

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    if (atBottom) {
      setAutoScroll(true);
    } else if (userScrollingRef.current && el.scrollTop < prevTop) {
      // 只有用户主动向上滚动（滚轮 / 触摸 / 滚动条 / 键盘）才关闭自动滚动。
      // 库的 scrollToEnd / 浏览器对 scrollTop 的 clamp 纠正导致的回调不会
      // 误关（input-marker 未标记），避免白屏恢复或高度校正后自动下翻失效。
      setAutoScroll(false);
    }
  };

  // 回到（或按 End / 拖滚动条到）底部时，把视口对齐到真正的底部。
  // scrollToEnd 会通过内部协调循环持续校准估算高度直到稳定，
  // 解决“按 End 只跳到接近末尾、要按好几次才到底”的问题。
  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    if (blocks.length > 0) virtualizer.scrollToEnd();
  }, [virtualizer, blocks.length]);

  // 贴底跟随：自动滚动开启时，新块追加 / 内容高度变化（译文完成、测量校准）
  // 都把视口拉回真正的底部。直接设置 scrollTop（scrollHeight = 虚拟内容总高），
  // 不启动库内部滚动协调循环，避免高频出块时的 rAF 开销，也不会被误拉回。
  useEffect(() => {
    if (!autoScroll || blocks.length === 0) return;
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoScroll, blocks, totalSize]);

  return (
    <Box
      sx={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        ref={parentRef}
        onScroll={handleScroll}
        onCopy={handleCopy}
        onMouseDown={(e) => {
          // 记录拖选起点所属的块：滚到底部后顶部块的 DOM 已被卸载，
          // copy 时拿不到锚点，只能用这里记下的索引。
          selectionAnchorRef.current = blockIndexFromNode(e.target as Node);
        }}
        onWheel={markUserScroll}
        onTouchStart={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={markUserScroll}
        tabIndex={0}
        sx={{ flex: 1, minHeight: 0, overflowY: "auto", outline: "none" }}
      >
        {!hasEnabledTranslationProvider && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
            {t("content.noProvider")}
          </Typography>
        )}
        <Box sx={{ height: totalSize, position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const block = blocks[virtualItem.index];
            return (
              <Box
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                sx={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <TranslationBlock
                  block={block}
                  showTranslation={hasEnabledTranslationProvider}
                  onDelete={() => onDelete(block.id)}
                  onTranslate={(provider) => translateBlock(block.id, provider)}
                  onRetry={(provider) => retryBlock(block.id, provider)}
                  onRetranslate={(provider) => retranslateBlock(block.id, provider)}
                />
              </Box>
            );
          })}
        </Box>
        {blocks.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            {t("content.noOutput")}
          </Typography>
        )}
      </Box>

      {/* 右下角浮动按钮组：纵向自适应排列（暂停在上、跳到底部在下）。
          跳到底部按钮隐藏时暂停会自动落到底部，不留空档。 */}
      <Box
        sx={{
          position: "absolute",
          right: 16,
          bottom: 16,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
        }}
      >
        {/* 暂停（常显）：暂停后仍接收文本，但不自动请求翻译，
            悬浮窗也保持显示暂停那一刻的文本。控制台线程不渲染本组件，故不显示。 */}
        <Tooltip title={paused ? t("content.resume") : t("content.pause")}>
          <Fab
            size="small"
            color={paused ? "warning" : "default"}
            aria-label={paused ? t("content.resume") : t("content.pause")}
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? <PlayArrowOutlinedIcon /> : <PauseOutlinedIcon />}
          </Fab>
        </Tooltip>

        {!autoScroll && blocks.length > 0 && (
          <Tooltip title={t("content.jumpToBottom")}>
            <Fab
              size="small"
              color="primary"
              aria-label={t("content.jumpToBottom")}
              onClick={scrollToBottom}
            >
              <KeyboardArrowDownIcon />
            </Fab>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
}
