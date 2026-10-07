import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Box, Divider, Menu, MenuItem, Paper, Select } from "@mui/material";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TextOutputArea } from "./TextOutputArea";
import { useHost } from "../host/HostContext";
import { useConfig } from "../settings/ConfigContext";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * hook 线程 id 形如 `pid:addr:ctx:ctx2`；返回其所属进程 PID。
 * 控制台/剪贴板/ws 这类全局线程返回 null。
 */
function threadOwnerPid(threadId: string): number | null {
  const pid = Number(threadId.split(":", 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

interface ContextMenuState {
  x: number;
  y: number;
  selectedText: string;
}

export function ConsolePanel() {
  const { t } = useTranslation();
  const { config } = useConfig();
  const {
    blocks,
    consoleLines,
    hookThreads,
    selectedThread,
    setSelectedThread,
    targetPid,
    clearConsole,
    clearText,
    deleteBlock,
  } = useHost();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleConsoleScroll = () => {
    const el = consoleRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [consoleLines, autoScroll]);

  const clearCurrentOutput = () => {
    if (selectedThread === "console") clearConsole();
    else clearText(selectedThread);
    setContextMenu(null);
  };

  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const selectedText = window.getSelection()?.toString().trim() ?? "";
    setContextMenu({ x: event.clientX, y: event.clientY, selectedText });
  };

  const handleGoogleSearch = () => {
    const text = contextMenu?.selectedText ?? "";
    setContextMenu(null);
    if (!text) return;
    const url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    if (isTauri()) {
      void openUrl(url).catch(() => {
        window.open(url, "_blank");
      });
    } else {
      window.open(url, "_blank");
    }
  };

  const handleCopySelection = () => {
    const text = contextMenu?.selectedText ?? "";
    setContextMenu(null);
    if (!text) return;
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const handleOpenDevtools = () => {
    setContextMenu(null);
    if (isTauri()) {
      void invoke("open_devtools").catch(() => {});
    }
  };

  const wsClientEnabled = config.websocket.clientEnabled;

  // 预过滤当前线程的文本块，避免每次渲染都对全部块做 O(N) 的 filter。
  const selectedBlocks = useMemo(
    () => blocks.filter((b) => b.threadId === selectedThread),
    [blocks, selectedThread],
  );
  const clipboardBlocks = useMemo(
    () => blocks.filter((b) => b.threadId === "clipboard"),
    [blocks],
  );

  // 只列出“当前目标进程”的文本线程：切换左上角目标后，其它进程的线程不会
  // 残留在下拉框里，也就不会误选到别的进程上（多开同名进程时最容易混淆）。
  const targetThreads = useMemo(
    () => hookThreads.filter((thread) => thread.pid === targetPid),
    [hookThreads, targetPid],
  );

  // 切换目标时同步切换正在查看的线程：记住各进程上次查看的线程，
  // 回到该进程时恢复；若当前停留在别的进程的线程上，则切到该进程（没有则控制台）。
  // 用 layout effect：在浏览器绘制前完成切换，避免下拉框短暂显示不属于本目标的线程。
  const selectedThreadRef = useRef(selectedThread);
  selectedThreadRef.current = selectedThread;
  const lastThreadByPidRef = useRef(new Map<number, string>());
  const prevTargetPidRef = useRef<number | null | undefined>(undefined);
  useLayoutEffect(() => {
    const prev = prevTargetPidRef.current;
    prevTargetPidRef.current = targetPid;
    if (prev === targetPid) return;
    const sel = selectedThreadRef.current;
    const owner = threadOwnerPid(sel);
    if (owner === null) return;
    // 记下这个线程的查看位置（下次切回它的进程时恢复）。
    lastThreadByPidRef.current.set(owner, sel);
    if (owner === targetPid) return;
    const remembered = targetPid !== null ? lastThreadByPidRef.current.get(targetPid) : undefined;
    setSelectedThread(
      remembered !== undefined && hookThreads.some((t) => t.id === remembered)
        ? remembered
        : "console",
    );
  }, [targetPid, hookThreads, setSelectedThread]);

  const threadOptions = [
    "console",
    "clipboard",
    ...(wsClientEnabled ? ["ws-client"] : []),
    ...targetThreads.map((t) => t.id),
  ];

  // 滚轮切换线程：到两端就停住，不做循环（循环时稍一多滚就会从最后一个
  // 跳回第一个，容易误选）。列表不足两项时不拦截滚轮。
  const handleThreadWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (threadOptions.length < 2) return;
    const idx = threadOptions.indexOf(selectedThread);
    if (idx < 0) return;
    event.preventDefault();
    const next = idx + (event.deltaY > 0 ? 1 : -1);
    if (next < 0 || next >= threadOptions.length) return;
    setSelectedThread(threadOptions[next]);
  };

  return (
    <Box
      onContextMenu={handleContextMenu}
      sx={{ display: "flex", flexDirection: "column", height: "100%", gap: 1.5, p: 1.5 }}
    >
      <Select
        value={selectedThread}
        onChange={(e) => setSelectedThread(e.target.value)}
        onWheel={handleThreadWheel}
        size="small"
        fullWidth
      >
        <MenuItem value="console">{t("content.console")}</MenuItem>
        <MenuItem value="clipboard">{t("content.clipboard")}</MenuItem>
        {wsClientEnabled && <MenuItem value="ws-client">{t("content.wsClient")}</MenuItem>}
        {targetThreads.map((thread) => {
          const hex = (n: number) => n.toString(16).toUpperCase();
          const label =
            `${hex(thread.handle)}:${hex(thread.pid)}:${hex(thread.addr)}:${hex(thread.ctx)}:${hex(thread.ctx2)}: ` +
            `${thread.name ?? ""}${thread.code ? ` (${thread.code})` : ""}`;
          return (
            <MenuItem key={thread.id} value={thread.id}>
              {label}
            </MenuItem>
          );
        })}
      </Select>

      {selectedThread !== "console" && selectedThread !== "clipboard" && (
        <TextOutputArea
          key={selectedThread}
          blocks={selectedBlocks}
          onDelete={deleteBlock}
        />
      )}

      {selectedThread === "console" && (
        <Paper
          ref={consoleRef}
          onScroll={handleConsoleScroll}
          variant="outlined"
          sx={{
            flex: 1,
            overflowY: "auto",
            bgcolor: "background.default",
            fontFamily: '"Consolas", "Courier New", monospace',
            fontSize: 13,
            lineHeight: 1.6,
            p: 1.5,
            whiteSpace: "pre-wrap",
          }}
        >
          {consoleLines.join("\n") || t("content.noOutput")}
        </Paper>
      )}

      {selectedThread === "clipboard" && (
        <TextOutputArea
          blocks={clipboardBlocks}
          onDelete={deleteBlock}
        />
      )}

      <Menu
        open={contextMenu !== null}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.y, left: contextMenu.x } : undefined}
      >
        <MenuItem onClick={handleCopySelection} disabled={(contextMenu?.selectedText ?? "") === ""}>
          {t("content.copy")}
        </MenuItem>
        <MenuItem onClick={handleGoogleSearch} disabled={(contextMenu?.selectedText ?? "") === ""}>
          {t("content.googleSearch")}
        </MenuItem>
        <Divider />
        <MenuItem onClick={clearCurrentOutput}>{t("content.clearOutput")}</MenuItem>
        {import.meta.env.DEV && (
          <>
            <Divider />
            <MenuItem onClick={handleOpenDevtools}>{t("content.openDevtools")}</MenuItem>
          </>
        )}
      </Menu>
    </Box>
  );
}
