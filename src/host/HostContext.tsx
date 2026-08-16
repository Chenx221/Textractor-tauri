import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConfig } from "../settings/ConfigContext";
import { useExtensions } from "../extensions/ExtensionsContext";
import type { TranslationExtension } from "../types/extensions";
import type { ExtraWindowText, TextBlock } from "../types/translation";

export interface SearchParam {
  text: string;
  codepage: number;
  pattern: string;
  offset: number;
  searchTime: number;
  maxRecords: number;
  module: string;
}

interface HostText {
  handle: number;
  pid: number;
  addr: number;
  ctx: number;
  ctx2: number;
  text: string;
  code: string | null;
  name: string | null;
}

interface HostConsole {
  message: string;
}

interface HookFound {
  pid: number;
  code: string;
  text: string;
}

interface HookRemoved {
  pid: number;
  address: number;
}

interface HookThread {
  id: string;
  handle: number;
  pid: number;
  addr: number;
  ctx: number;
  ctx2: number;
  code: string | null;
  name: string | null;
}

// 每个线程最多保留的文本块数量，超出后丢弃最旧的，避免长时间运行时 DOM 无限增长。
const MAX_BLOCKS_PER_THREAD = 2000;

interface HostContextValue {
  /** 当前已建立管道连接的目标进程 PID 列表。 */
  connectedPids: number[];
  /** 已出现的 hook 线程（用于线程下拉框）。 */
  hookThreads: HookThread[];
  consoleLines: string[];
  /** hook 搜索结果。 */
  searchResults: HookFound[];
  blocks: TextBlock[];
  /** 当前查看的线程（"console" / "clipboard" / hook 线程 id）。 */
  selectedThread: string;
  setSelectedThread: (threadId: string) => void;
  /** 手动翻译某个文本块（所有未请求的翻译服务）。 */
  translateBlock: (id: string) => void;
  /** 翻译失败后重试指定服务。 */
  retryBlock: (id: string, provider: string) => void;
  attach: (pid: number) => void;
  detach: (pid: number) => void;
  insertHook: (pid: number, code: string) => void;
  removeHook: (pid: number, address: number) => void;
  findHooks: (pid: number, param: SearchParam) => void;
  saveHooks: (pid: number) => void;
  clearConsole: () => void;
  clearSearchResults: () => void;
  clearText: (threadId?: string) => void;
  deleteBlock: (id: string) => void;
}

const HostContext = createContext<HostContextValue | null>(null);

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function HostProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const {
    translateWith,
    filterOriginal,
    filterTranslation,
    runSideEffectTools,
    hasEnabledTranslationProvider,
    activeTranslators,
    romanizeJa,
  } = useExtensions();
  const [connectedPids, setConnectedPids] = useState<number[]>([]);
  const [hookThreads, setHookThreads] = useState<HookThread[]>([]);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<HookFound[]>([]);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [selectedThread, setSelectedThread] = useState("console");

  // 事件监听注册后是固定闭包，用 ref 保存最新函数/状态引用。
  const translateRef = useRef(translateWith);
  translateRef.current = translateWith;
  const filterRef = useRef(filterOriginal);
  filterRef.current = filterOriginal;
  const filterTranslationRef = useRef(filterTranslation);
  filterTranslationRef.current = filterTranslation;
  const sideEffectRef = useRef(runSideEffectTools);
  sideEffectRef.current = runSideEffectTools;
  const hasProviderRef = useRef(hasEnabledTranslationProvider);
  hasProviderRef.current = hasEnabledTranslationProvider;
  const activeTranslatorsRef = useRef(activeTranslators);
  activeTranslatorsRef.current = activeTranslators;
  const selectedThreadRef = useRef(selectedThread);
  selectedThreadRef.current = selectedThread;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const romanizeRef = useRef(romanizeJa);
  romanizeRef.current = romanizeJa;

  const requestTranslationEntry = useCallback(
    (blockId: string, provider: string, text: string, translator: TranslationExtension) => {
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? {
                ...b,
                translations: b.translations.map((t) =>
                  t.provider === provider ? { ...t, state: "loading", error: undefined } : t,
                ),
              }
            : b,
        ),
      );
      // 上下文：取当前线程在目标块之前的最近 N 句非空原文。
      const contextCount = parseInt(translator.settings.contextSentences ?? "0", 10) || 0;
      let context: string[] | undefined;
      if (contextCount > 0) {
        const all = blocksRef.current;
        const idx = all.findIndex((b) => b.id === blockId);
        const threadId = idx >= 0 ? all[idx].threadId : undefined;
        if (threadId && idx > 0) {
          const history = all
            .filter((b, i) => i < idx && b.threadId === threadId && b.original.trim() !== "")
            .slice(-contextCount)
            .map((b) => b.original);
          if (history.length > 0) context = history;
        }
      }
      translateRef
        .current(text, translator, context)
        .then((outcome) => {
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId
                ? {
                    ...b,
                    translations: b.translations.map((t) =>
                      t.provider === provider
                        ? {
                            ...t,
                            state: "done",
                            text: filterTranslationRef.current(outcome.translation),
                            fromCache: outcome.fromCache,
                            error: undefined,
                          }
                        : t,
                    ),
                  }
                : b,
            ),
          );
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setBlocks((prev) =>
            prev.map((b) =>
              b.id === blockId
                ? {
                    ...b,
                    translations: b.translations.map((t) =>
                      t.provider === provider ? { ...t, state: "error", error: message } : t,
                    ),
                  }
                : b,
            ),
          );
        });
    },
    [],
  );

  const addBlock = useCallback(
    (threadId: string, rawText: string) => {
      const original = filterRef.current(rawText, threadId);
      sideEffectRef.current(original, threadId);
      const id = `${threadId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const translators = activeTranslatorsRef.current;
      const translations = translators.map((t) => ({
        provider: t.provider,
        state: "pending" as const,
      }));
      setBlocks((prev) => {
        const block = { id, original, translations, threadId };
        const existing = prev.filter((b) => b.threadId === threadId).length;
        const overflow = existing - (MAX_BLOCKS_PER_THREAD - 1);
        if (overflow <= 0) return [...prev, block];
        let skipped = 0;
        const kept = prev.filter((b) => {
          if (b.threadId === threadId && skipped < overflow) {
            skipped += 1;
            return false;
          }
          return true;
        });
        return [...kept, block];
      });
      // 罗马音标注（仅显示，不影响翻译）。
      if (original.trim() !== "") {
        void romanizeRef.current(original).then((romanji) => {
          if (romanji) {
            setBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, romanji } : b)));
          }
        });
      }
      // 只自动翻译当前查看的文本线程；其他线程留手动翻译按钮。
      if (original.trim() !== "" && threadId === selectedThreadRef.current) {
        for (const t of translators) {
          requestTranslationEntry(id, t.provider, original, t);
        }
      }
    },
    [requestTranslationEntry],
  );

  const translateBlock = useCallback(
    (id: string) => {
      const block = blocks.find((b) => b.id === id);
      if (!block) return;
      for (const t of activeTranslatorsRef.current) {
        const entry = block.translations.find((e) => e.provider === t.provider);
        if (entry && entry.state === "pending") {
          requestTranslationEntry(id, t.provider, block.original, t);
        }
      }
    },
    [blocks, requestTranslationEntry],
  );

  const retryBlock = useCallback(
    (id: string, provider: string) => {
      const block = blocks.find((b) => b.id === id);
      if (!block) return;
      const t = activeTranslatorsRef.current.find((x) => x.provider === provider);
      if (t) requestTranslationEntry(id, provider, block.original, t);
    },
    [blocks, requestTranslationEntry],
  );

  useEffect(() => {
    if (!isTauri()) return;

    // 幂等：Rust 侧只会启动一次管道服务。
    void invoke("host_start").catch(() => {});
    // 启动时自动 attach 已保存的游戏（gap 7）。
    void invoke("auto_attach").catch(() => {});

    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      listen<number>("host-connected", (event) => {
        setConnectedPids((prev) =>
          prev.includes(event.payload) ? prev : [...prev, event.payload],
        );
        setConsoleLines((prev) => [...prev, `Connected to process ${event.payload}`]);
      }),
    );
    unlisteners.push(
      listen<number>("host-disconnected", (event) => {
        setConnectedPids((prev) => prev.filter((pid) => pid !== event.payload));
        setHookThreads((prev) => prev.filter((t) => t.pid !== event.payload));
        // 当前选中的若是被分离进程的线程，切回控制台，避免下方残留旧线程内容。
        const sel = selectedThreadRef.current;
        if (sel !== "console" && sel !== "clipboard") {
          if (sel.split(":")[0] === String(event.payload)) {
            setSelectedThread("console");
          }
        }
        setConsoleLines((prev) => [...prev, `Process ${event.payload} disconnected`]);
      }),
    );
    unlisteners.push(
      listen<HostConsole>("host-console", (event) => {
        setConsoleLines((prev) => [...prev, event.payload.message]);
      }),
    );
    unlisteners.push(
      listen<HostText>("host-text", (event) => {
        const { handle, pid, addr, ctx, ctx2, text, code, name } = event.payload;
        const threadId = `${pid}:${addr}:${ctx}:${ctx2}`;
        setHookThreads((prev) =>
          prev.some((t) => t.id === threadId)
            ? prev
            : [...prev, { id: threadId, handle, pid, addr, ctx, ctx2, code, name }],
        );
        addBlock(threadId, text);
      }),
    );
    unlisteners.push(
      listen<string>("host-clipboard", (event) => {
        addBlock("clipboard", event.payload);
      }),
    );
    unlisteners.push(
      listen<string>("ws-client-text", (event) => {
        addBlock("ws-client", event.payload);
      }),
    );
    unlisteners.push(
      listen<HookFound>("host-hook-found", (event) => {
        setSearchResults((prev) => [...prev, event.payload]);
        setConsoleLines((prev) => [...prev, `${event.payload.code} => ${event.payload.text}`]);
      }),
    );
    unlisteners.push(
      listen<HookRemoved>("host-hook-removed", (event) => {
        const { pid, address } = event.payload;
        setHookThreads((prev) => prev.filter((t) => !(t.pid === pid && t.addr === address)));
        setConsoleLines((prev) => [...prev, `Hook removed @ 0x${address.toString(16)}`]);
      }),
    );

    return () => {
      for (const unlisten of unlisteners) {
        void unlisten.then((fn) => fn());
      }
    };
  }, []);

  // 把 TextThread 设置同步给宿主（filterRepetition / flush 间距等）。
  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_thread_settings", { settings: config.textThread }).catch(() => {});
  }, [config.textThread]);

  // 当前查看线程的最新文本块，转发给无边框悬浮窗（extra window）。
  const latestBlock = useMemo(() => {
    const list = blocks.filter((b) => b.threadId === selectedThread);
    return list.length > 0 ? list[list.length - 1] : null;
  }, [blocks, selectedThread]);

  useEffect(() => {
    if (!isTauri()) return;
    const payload: ExtraWindowText = latestBlock
      ? {
          original: latestBlock.original,
          threadId: latestBlock.threadId ?? selectedThread,
          translations: latestBlock.translations,
          romanji: latestBlock.romanji,
        }
      : { original: "", threadId: selectedThread, translations: [] };
    void emit("extra-window-text", payload).catch(() => {});
  }, [latestBlock, selectedThread]);

  // WebSocket 服务端：把当前查看线程的最新文本广播给已连接客户端
  // （忽略控制台；剪切板需显式开启）。
  useEffect(() => {
    if (!isTauri()) return;
    if (!config.websocket.serverEnabled) return;
    if (selectedThread === "console") return;
    if (selectedThread === "clipboard" && !config.websocket.serverIncludeClipboard) return;
    const text = latestBlock?.original;
    if (text && text.trim() !== "") {
      void invoke("ws_broadcast", { text }).catch(() => {});
    }
  }, [
    latestBlock,
    selectedThread,
    config.websocket.serverEnabled,
    config.websocket.serverIncludeClipboard,
  ]);

  // WebSocket 客户端关闭时，若正查看 ws 线程则切回控制台。
  useEffect(() => {
    if (!config.websocket.clientEnabled && selectedThread === "ws-client") {
      setSelectedThread("console");
    }
  }, [config.websocket.clientEnabled, selectedThread]);

  const attach = useCallback((pid: number) => {
    if (isTauri()) void invoke("inject_process", { pid }).catch(() => {});
  }, []);

  const detach = useCallback((pid: number) => {
    if (isTauri()) void invoke("detach_process", { pid }).catch(() => {});
  }, []);

  const insertHook = useCallback((pid: number, code: string) => {
    if (isTauri()) void invoke("insert_hook", { pid, code }).catch(() => {});
  }, []);

  const removeHook = useCallback((pid: number, address: number) => {
    if (isTauri()) void invoke("remove_hook", { pid, address }).catch(() => {});
  }, []);

  const findHooks = useCallback((pid: number, param: SearchParam) => {
    if (isTauri()) void invoke("find_hooks", { pid, param }).catch(() => {});
  }, []);

  const saveHooks = useCallback((pid: number) => {
    if (!isTauri()) return;
    void invoke<{ code: string; address: number; is_engine: boolean }[]>("list_hooks", { pid })
      .then((hooks) =>
        invoke("save_hooks", {
          pid,
          codes: hooks.filter((hook) => !hook.is_engine).map((hook) => hook.code),
        }),
      )
      .catch(() => {});
  }, []);

  const clearConsole = useCallback(() => setConsoleLines([]), []);
  const clearSearchResults = useCallback(() => setSearchResults([]), []);
  const clearText = useCallback((threadId?: string) => {
    setBlocks((prev) =>
      threadId ? prev.filter((block) => block.threadId !== threadId) : [],
    );
  }, []);
  const deleteBlock = useCallback(
    (id: string) => setBlocks((prev) => prev.filter((block) => block.id !== id)),
    [],
  );

  const value = useMemo<HostContextValue>(
    () => ({
      connectedPids,
      hookThreads,
      consoleLines,
      searchResults,
      blocks,
      selectedThread,
      setSelectedThread,
      translateBlock,
      retryBlock,
      attach,
      detach,
      insertHook,
      removeHook,
      findHooks,
      saveHooks,
      clearConsole,
      clearSearchResults,
      clearText,
      deleteBlock,
    }),
    [
      connectedPids,
      hookThreads,
      consoleLines,
      searchResults,
      blocks,
      selectedThread,
      translateBlock,
      retryBlock,
      attach,
      detach,
      insertHook,
      removeHook,
      findHooks,
      saveHooks,
      clearConsole,
      clearSearchResults,
      clearText,
      deleteBlock,
    ],
  );

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHost(): HostContextValue {
  const ctx = useContext(HostContext);
  if (!ctx) throw new Error("useHost must be used within HostProvider");
  return ctx;
}

