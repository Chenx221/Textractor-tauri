import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Box, Divider, Menu, MenuItem, Paper, Select } from "@mui/material";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { TextOutputArea } from "./TextOutputArea";
import { useHost } from "../host/HostContext";
import { useConfig } from "../settings/ConfigContext";
import type { TextBlock } from "../types/translation";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
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

  const copyBlock = (block: TextBlock) => {
    const done = block.translations.find((e) => e.state === "done" && e.text);
    const text = done?.text ?? block.original;
    void navigator.clipboard.writeText(text).catch(() => {});
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

  const threadOptions = [
    "console",
    "clipboard",
    ...(wsClientEnabled ? ["ws-client"] : []),
    ...hookThreads.map((t) => t.id),
  ];

  const handleThreadWheel = (event: React.WheelEvent<HTMLElement>) => {
    if (threadOptions.length < 2) return;
    const idx = threadOptions.indexOf(selectedThread);
    const dir = event.deltaY > 0 ? 1 : -1;
    const next = threadOptions[(idx + dir + threadOptions.length) % threadOptions.length];
    setSelectedThread(next);
    event.preventDefault();
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
        {hookThreads.map((thread) => {
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
          blocks={blocks.filter((b) => b.threadId === selectedThread)}
          onDelete={deleteBlock}
          onCopy={copyBlock}
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
          blocks={blocks.filter((b) => b.threadId === "clipboard")}
          onDelete={deleteBlock}
          onCopy={copyBlock}
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
