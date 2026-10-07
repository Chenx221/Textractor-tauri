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
import type { ProcessInfo } from "../types/process";
import type {
  ExtraWindowHistoryRequest,
  ExtraWindowText,
  TextBlock,
  TranslationEntry,
} from "../types/translation";

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

interface SavedThreadEvent {
  handle: number;
  pid: number;
  addr: number;
  ctx: number;
  ctx2: number;
  code: string | null;
  name: string | null;
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

/** 进程信息缺失时的兜底对象，保证目标选框里至少有一项可切。 */
function fallbackProcessInfo(pid: number): ProcessInfo {
  return {
    pid,
    name: `PID ${pid}`,
    title: "",
    arch: "",
    has_file: false,
    is_system: false,
    icon: null,
  };
}

/** 把文本块转换为转发给悬浮窗的载荷。 */
function toExtraWindowText(block: TextBlock, fallbackThreadId: string): ExtraWindowText {
  return {
    id: block.id,
    original: block.original,
    threadId: block.threadId ?? fallbackThreadId,
    translations: block.translations,
    romanji: block.romanji,
  };
}

interface HostContextValue {
  /** 当前已建立管道连接的目标进程 PID 列表。 */
  connectedPids: number[];
  /**
   * 已附加的目标进程（可多个）。UI 里的“当前目标”只是其中一个，
   * 切换目标不会断开其它进程，但文本线程/hook 列表都只按当前目标展示。
   */
  targets: ProcessInfo[];
  /** 当前操作目标 PID（左上角进程选框的值，null = 未附加）。 */
  targetPid: number | null;
  /** 切换当前操作目标。 */
  setTargetPid: (pid: number) => void;
  /** 已出现的 hook 线程（用于线程下拉框）。 */
  hookThreads: HookThread[];
  consoleLines: string[];
  /** hook 搜索结果。 */
  searchResults: HookFound[];
  blocks: TextBlock[];
  /** 当前查看的线程（"console" / "clipboard" / hook 线程 id）。 */
  selectedThread: string;
  setSelectedThread: (threadId: string) => void;
  /**
   * 暂停：仍接收文本（照常入列到输出区），但不自动发起翻译请求；
   * 同时悬浮窗不再切换到新文本，保持显示暂停那一刻的一条。
   */
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** 手动翻译某个文本块的指定翻译服务。 */
  translateBlock: (id: string, provider: string) => void;
  /** 翻译失败后重试指定服务。 */
  retryBlock: (id: string, provider: string) => void;
  /** 对已完成的译文重新翻译（绕过缓存）。 */
  retranslateBlock: (id: string, provider: string) => void;
  /** 重新计算所有历史块的罗马音（重载自定义词典后调用）。 */
  reromanizeAll: () => Promise<void>;
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
  const [targets, setTargets] = useState<ProcessInfo[]>([]);
  const [targetPid, setTargetPidState] = useState<number | null>(null);
  const [hookThreads, setHookThreads] = useState<HookThread[]>([]);
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<HookFound[]>([]);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [selectedThread, setSelectedThread] = useState("console");
  const [paused, setPaused] = useState(false);

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
  const hookThreadsRef = useRef(hookThreads);
  hookThreadsRef.current = hookThreads;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const romanizeRef = useRef(romanizeJa);
  romanizeRef.current = romanizeJa;
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  // 手动附加后待选中的 PID：连接事件到达时把它设为当前目标
  // （自动附加的进程只在还没有目标时才接管，避免抢走用户正在看的目标）。
  const selectOnConnectRef = useRef<number | null>(null);

  // 单个块内容变化时通知悬浮窗：它本地缓冲/当前显示里若含这条就同步刷新。
  // 否则用户在历史文本上手动翻译时，悬浮窗里那条会一直停留在旧内容。
  const notifyBlockUpdate = useCallback((block: TextBlock) => {
    if (!isTauri()) return;
    const threadId = block.threadId ?? selectedThreadRef.current;
    if (threadId !== selectedThreadRef.current) return;
    void emit("extra-window-text-update", toExtraWindowText(block, threadId)).catch(() => {});
  }, []);

  // 修改单个文本块：先算出一份新块用于通知，再做状态更新。
  // 不能在 setBlocks 的 updater 里发事件（updater 可能被重复调用或延后执行）。
  const patchBlock = useCallback(
    (blockId: string, fn: (block: TextBlock) => TextBlock) => {
      setBlocks((prev) => prev.map((block) => (block.id === blockId ? fn(block) : block)));
      const src = blocksRef.current.find((block) => block.id === blockId);
      if (src) notifyBlockUpdate(fn(src));
    },
    [notifyBlockUpdate],
  );

  const setTranslationState = useCallback(
    (blockId: string, provider: string, patch: Partial<TranslationEntry>) => {
      patchBlock(blockId, (block) => ({
        ...block,
        translations: block.translations.map((entry) =>
          entry.provider === provider ? { ...entry, ...patch } : entry,
        ),
      }));
    },
    [patchBlock],
  );

  const requestTranslationEntry = useCallback(
    (
      blockId: string,
      provider: string,
      text: string,
      translator: TranslationExtension,
      skipCache = false,
    ) => {
      setTranslationState(blockId, provider, { state: "loading", error: undefined });
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
        .current(text, translator, context, skipCache)
        .then((outcome) => {
          setTranslationState(blockId, provider, {
            state: "done",
            text: filterTranslationRef.current(outcome.translation),
            fromCache: outcome.fromCache,
            error: undefined,
          });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setTranslationState(blockId, provider, { state: "error", error: message });
        });
    },
    [setTranslationState],
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
          if (romanji) patchBlock(id, (b) => ({ ...b, romanji }));
        });
      }
      // 只自动翻译当前查看的文本线程；其他线程留手动翻译按钮。
      // 暂停时仍接收文本（块照常入列），但不发起自动翻译请求。
      if (
        original.trim() !== "" &&
        threadId === selectedThreadRef.current &&
        !pausedRef.current
      ) {
        for (const t of translators) {
          requestTranslationEntry(id, t.provider, original, t);
        }
      }
    },
    [patchBlock, requestTranslationEntry],
  );

  const translateBlock = useCallback(
    (id: string, provider: string) => {
      const block = blocks.find((b) => b.id === id);
      if (!block) return;
      const t = activeTranslatorsRef.current.find((x) => x.provider === provider);
      if (!t) return;
      const entry = block.translations.find((e) => e.provider === provider);
      if (entry && entry.state === "pending") {
        requestTranslationEntry(id, provider, block.original, t);
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

  // “重新翻译”：对已完成的译文重新请求翻译服务，绕过缓存读取。
  const retranslateBlock = useCallback(
    (id: string, provider: string) => {
      const block = blocksRef.current.find((b) => b.id === id);
      if (!block) return;
      const t = activeTranslatorsRef.current.find((x) => x.provider === provider);
      if (t) requestTranslationEntry(id, provider, block.original, t, true);
    },
    [requestTranslationEntry],
  );

  useEffect(() => {
    if (!isTauri()) return;

    // 幂等：Rust 侧只会启动一次管道服务。
    void invoke("host_start").catch(() => {});
    // 启动时自动 attach 已保存的游戏（gap 7）。
    void invoke("auto_attach").catch(() => {});
    // 窗口重新加载（开发热更新 / 刷新）时后端可能已经连着进程，
    // 但不会有 host-connected 补发，所以主动同步一次目标列表。
    void invoke<number[]>("connected_processes")
      .then((pids) => {
        if (!pids || pids.length === 0) return;
        void invoke<ProcessInfo[]>("list_processes")
          .then((list) => {
            const infos = pids.map(
              (pid) => list.find((p) => p.pid === pid) ?? fallbackProcessInfo(pid),
            );
            setTargets((prev) => {
              const merged = [...prev];
              for (const info of infos) {
                if (!merged.some((t) => t.pid === info.pid)) merged.push(info);
              }
              return merged;
            });
            setTargetPidState((prev) => prev ?? infos[0].pid);
          })
          .catch(() => {});
      })
      .catch(() => {});

    const unlisteners: Promise<UnlistenFn>[] = [];

    unlisteners.push(
      listen<number>("host-connected", (event) => {
        const pid = event.payload;
        setConnectedPids((prev) =>
          prev.includes(pid) ? prev : [...prev, pid],
        );
        setConsoleLines((prev) => [...prev, `Connected to process ${pid}`]);
        // 登记为目标进程，并决定是否把它切为当前目标：
        // 手动附加的总是接管；自动附加只在还没有目标时接管。
        void invoke<ProcessInfo[]>("list_processes")
          .then((list) => {
            const info = list.find((p) => p.pid === pid) ?? fallbackProcessInfo(pid);
            setTargets((prev) => (prev.some((t) => t.pid === pid) ? prev : [...prev, info]));
            setTargetPidState((prev) =>
              prev === null || selectOnConnectRef.current === pid ? pid : prev,
            );
          })
          .catch(() => {
            setTargets((prev) =>
              prev.some((t) => t.pid === pid) ? prev : [...prev, fallbackProcessInfo(pid)],
            );
            setTargetPidState((prev) =>
              prev === null || selectOnConnectRef.current === pid ? pid : prev,
            );
          })
          .finally(() => {
            if (selectOnConnectRef.current === pid) selectOnConnectRef.current = null;
          });
      }),
    );
    unlisteners.push(
      listen<number>("host-disconnected", (event) => {
        const pid = event.payload;
        setConnectedPids((prev) => prev.filter((p) => p !== pid));
        setHookThreads((prev) => prev.filter((t) => t.pid !== pid));
        // 目标进程被分离：从目标列表移除；若它正是当前目标，
        // 切到剩下的第一个（没有则置空），避免选框停在一个已失效的进程上。
        setTargets((prev) => prev.filter((t) => t.pid !== pid));
        setTargetPidState((prev) =>
          prev === pid ? (targetsRef.current.find((t) => t.pid !== pid)?.pid ?? null) : prev,
        );
        // 当前选中的若是被分离进程的线程，切回控制台，避免下方残留旧线程内容。
        const sel = selectedThreadRef.current;
        if (sel !== "console" && sel !== "clipboard") {
          if (sel.split(":")[0] === String(pid)) {
            setSelectedThread("console");
          }
        }
        setConsoleLines((prev) => [...prev, `Process ${pid} disconnected`]);
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
    unlisteners.push(
      listen<SavedThreadEvent>("host-saved-thread", (event) => {
        // 自动附加后恢复到保存时查看的文本线程（等价于原版 ThreadAdded 自动切换）。
        const { handle, pid, addr, ctx, ctx2, code, name } = event.payload;
        const threadId = `${pid}:${addr}:${ctx}:${ctx2}`;
        setHookThreads((prev) =>
          prev.some((t) => t.id === threadId)
            ? prev.map((t) =>
                t.id === threadId ? { ...t, handle, code: code ?? t.code, name: name ?? t.name } : t,
              )
            : [...prev, { id: threadId, handle, pid, addr, ctx, ctx2, code, name }],
        );
        setSelectedThread(threadId);
      }),
    );
    // 悬浮窗滚轮上翻时按需返回历史文本（以块 id 为锚点，新块到达不会导致错位）。
    unlisteners.push(
      listen<ExtraWindowHistoryRequest>("extra-window-history-request", (event) => {
        const { threadId, beforeId, limit } = event.payload;
        // 空原文块（被工具过滤掉）不参与历史浏览。
        const list = blocksRef.current.filter(
          (b) => b.threadId === threadId && b.original.trim() !== "",
        );
        const max = Math.max(1, Math.min(limit || 0, 500));
        let end = beforeId === null ? list.length : list.findIndex((b) => b.id === beforeId);
        if (end < 0) end = 0;
        const start = Math.max(0, end - max);
        const entries = list.slice(start, end).map((b) => toExtraWindowText(b, threadId));
        void emit("extra-window-history", {
          threadId,
          total: list.length,
          hasMore: start > 0,
          entries,
        }).catch(() => {});
      }),
    );

    // 悬浮窗右上角的暂停按钮 → 与主窗口共享同一暂停状态。
    unlisteners.push(
      listen<{ paused: boolean }>("extra-window-set-paused", (event) => {
        setPaused(event.payload.paused);
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
    const current: ExtraWindowText = latestBlock
      ? toExtraWindowText(latestBlock, selectedThread)
      : { id: "", original: "", threadId: selectedThread, translations: [] };
    // 暂停时仍然转发：悬浮窗照常把新文本记进历史缓冲（否则恢复后历史会出现空洞），
    // 但带上 `hold` 标记让它只记录、不切换到新文本。
    void emit("extra-window-text", { ...current, hold: paused }).catch(() => {});
  }, [latestBlock, selectedThread, paused]);

  // 暂停状态同步给悬浮窗（其右上角也有暂停按钮，两处共享同一状态）。
  useEffect(() => {
    if (!isTauri()) return;
    void emit("extra-window-paused", { paused }).catch(() => {});
  }, [paused]);

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
    // 已经附加过了（后端也会忽略重复注入，不再发 host-connected）：直接切过去。
    if (targetsRef.current.some((t) => t.pid === pid)) {
      setTargetPidState(pid);
      return;
    }
    selectOnConnectRef.current = pid;
    if (isTauri()) void invoke("inject_process", { pid }).catch(() => {});
  }, []);

  const setTargetPid = useCallback((pid: number) => setTargetPidState(pid), []);

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
      .then((hooks) => {
        const codes = hooks.filter((hook) => !hook.is_engine).map((hook) => hook.code);
        // 若当前查看的是该进程的有效文本线程（非控制台/剪贴板/ws），
        // 一并保存其 ctx/ctx2/code，自动附加后会切换回该线程（等价于原版 SaveHooks）。
        let currentThread: { ctx: number; ctx2: number; code: string } | null = null;
        const sel = selectedThreadRef.current;
        if (sel !== "console" && sel !== "clipboard" && sel !== "ws-client") {
          const parts = sel.split(":");
          if (parts.length === 4 && Number(parts[0]) === pid) {
            const thread = hookThreadsRef.current.find((t) => t.id === sel);
            if (thread?.code) {
              currentThread = { ctx: thread.ctx, ctx2: thread.ctx2, code: thread.code };
            }
          }
        }
        return invoke("save_hooks", { pid, codes, currentThread });
      })
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

  /**
   * 重算所有历史块的罗马音。自定义词典重载后调用，让已经显示过的行也用上
   * 新词条（否则要等新文本到达才会生效）。只处理已经有罗马音的块，
   * 计算结果为空时保留原值（词典未安装 / 工具刚被关闭）。
   */
  const reromanizeAll = useCallback(async () => {
    const pending = blocksRef.current.filter(
      (block) => block.romanji !== undefined && block.original.trim() !== "",
    );
    for (const block of pending) {
      const romanji = await romanizeRef.current(block.original);
      if (!romanji) continue;
      patchBlock(block.id, (current) => ({ ...current, romanji }));
    }
  }, [patchBlock]);

  const value = useMemo<HostContextValue>(
    () => ({
      connectedPids,
      targets,
      targetPid,
      setTargetPid,
      hookThreads,
      consoleLines,
      searchResults,
      blocks,
      selectedThread,
      setSelectedThread,
      paused,
      setPaused,
      translateBlock,
      retryBlock,
      retranslateBlock,
      reromanizeAll,
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
      targets,
      targetPid,
      setTargetPid,
      hookThreads,
      consoleLines,
      searchResults,
      blocks,
      selectedThread,
      paused,
      setPaused,
      translateBlock,
      retryBlock,
      retranslateBlock,
      reromanizeAll,
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

