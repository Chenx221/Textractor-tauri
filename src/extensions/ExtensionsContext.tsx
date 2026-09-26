import { useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useConfig } from "../settings/ConfigContext";
import type {
  Extension,
  ToolExtension,
  TranslationExtension,
} from "../types/extensions";
import { TOOL_DEFS, TRANSLATOR_DEFS } from "../types/extensions";

export interface TranslateOutcome {
  translation: string;
  fromCache: boolean;
  provider: string;
}

interface ExtensionsContextValue {
  extensions: Extension[];
  hasEnabledTranslationProvider: boolean;
  /** 第一个已启用的翻译扩展。 */
  activeTranslator: TranslationExtension | null;
  /** 所有已启用的翻译扩展（按顺序，多个服务可同时显示译文）。 */
  activeTranslators: TranslationExtension[];
  /** 所有翻译扩展（用于显示顺序）。 */
  translators: TranslationExtension[];
  updateExtension: (id: string, patch: Record<string, unknown>) => void;
  moveExtension: (id: string, dir: -1 | 1) => void;
  addExtension: (kind: "translation" | "tool", providerOrTool: string) => void;
  removeExtension: (id: string) => void;
  /** 对原文依次执行已启用的工具扩展（在翻译请求前调用）。 */
  filterOriginal: (text: string, threadId?: string) => string;
  /** 对译文执行已启用的译文工具扩展（如正则替换译文）。 */
  filterTranslation: (text: string) => string;
  /** 执行已启用的副作用工具（如复制到剪贴板）。 */
  runSideEffectTools: (text: string, threadId?: string) => void;
  /** 调用后端 translate_text 翻译文本（含缓存）。 */
  translate: (text: string) => Promise<TranslateOutcome>;
  /** 用指定翻译器（或第一个启用的）翻译文本；skipCache 为 true 时绕过缓存读取。 */
  translateWith: (
    text: string,
    translator?: TranslationExtension,
    context?: string[],
    skipCache?: boolean,
  ) => Promise<TranslateOutcome>;
  /** 罗马音标注：若启用了 romanji 工具则返回罗马音，否则返回 null。 */
  romanizeJa: (text: string) => Promise<string | null>;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

// ---- 工具扩展算法（纯函数） ----

function removeRepeatedChars(text: string): string {
  const counts = new Map<number, number>();
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    const run = j - i;
    counts.set(run, (counts.get(run) ?? 0) + 1);
    i = j;
  }
  let repeatNumber = 1;
  let bestCount = 0;
  for (const [len, count] of counts) {
    if (len >= 2 && count > bestCount) {
      bestCount = count;
      repeatNumber = len;
    }
  }
  if (repeatNumber < 2) return text;
  let out = "";
  i = 0;
  while (i < text.length) {
    out += text[i];
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    const run = j - i;
    i += run % repeatNumber === 0 ? repeatNumber : 1;
  }
  return out;
}

function removeRepeatPhrase(text: string): string {
  let result = text;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    for (let unitLen = Math.floor(result.length / 2); unitLen >= 2; unitLen--) {
      for (let i = 0; i + 2 * unitLen <= result.length; i++) {
        const a = result.slice(i, i + unitLen);
        if (a.trim().length === 0) continue;
        if (a === result.slice(i + unitLen, i + 2 * unitLen)) {
          result = result.slice(0, i) + a + result.slice(i + 2 * unitLen);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return result;
}

// 内置语言字符替换表（日文全角 → 半角）。
const DEFAULT_LANGUAGE_CHAR_TABLE: [string, string][] = [
  ["……。", "..."],
  ["…", "..."],
  ["──", "─"],
  ["。", "."],
  ["、", ","],
  ["．", "."],
  ["・", "."],
  ["〝", '"'],
  ["〟", '"'],
  ["「", '"'],
  ["」", '"'],
  ["《", "<<"],
  ["》", ">>"],
  ["『", "'"],
  ["』", "'"],
  ["（", "("],
  ["）", ")"],
  ["～", "~"],
  ["＊", "*"],
  ["●", "***"],
  ["？", "?"],
  ["！", "!"],
  ["０", "0"],
  ["１", "1"],
  ["２", "2"],
  ["３", "3"],
  ["４", "4"],
  ["５", "5"],
  ["６", "6"],
  ["７", "7"],
  ["８", "8"],
  ["９", "9"],
];

/** 解析 `|ORIG|原文|BECOMES|替换|END|` 格式的替换表。 */
function parseReplacementTable(content: string): [string, string][] {
  const pairs: [string, string][] = [];
  const re = /\|ORIG\|([\s\S]*?)\|BECOMES\|([\s\S]*?)\|END\|/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const original = match[1].replace(/\u200b/g, "");
    if (original !== "") pairs.push([original, match[2]]);
  }
  return pairs;
}

function applyReplacementTable(text: string, pairs: [string, string][]): string {
  let result = text;
  for (const [from, to] of pairs) {
    result = result.split(from).join(to);
  }
  return result;
}

// 有状态工具：per-thread 状态。
const leadingPrev = new Map<string, string>();
const sentenceCache = new Map<string, string[]>();

function removeRepeatedLeadingSentence(text: string, threadId: string): string {
  const key = threadId || "__default__";
  const prev = leadingPrev.get(key) ?? "";
  leadingPrev.set(key, text);
  if (prev !== "" && text.startsWith(prev)) {
    return text.slice(prev.length).replace(/^\s+/, "");
  }
  return text;
}

function removeRepeatSentence(text: string, threadId: string, cacheSize: number): string {
  const key = threadId || "__default__";
  const size = cacheSize > 0 ? cacheSize : 30;
  const cache = sentenceCache.get(key) ?? [];
  const idx = cache.indexOf(text);
  if (idx >= 0) {
    cache.splice(idx, 1);
    return "";
  }
  cache.push(text);
  while (cache.length > size) cache.shift();
  sentenceCache.set(key, cache);
  return text;
}

export function useExtensions(): ExtensionsContextValue {
  const { config, setExtensions } = useConfig();
  const extensions = config.extensions;
  const translateTimeoutMs = config.translateTimeoutMs;

  // 缓存 file 类型字段的文件内容（替换表/过滤表）。
  const tableCache = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!isTauri()) return;
    const paths: string[] = [];
    for (const ext of extensions) {
      if (ext.kind !== "tool") continue;
      const def = TOOL_DEFS.find((d) => d.id === ext.tool);
      for (const field of def?.fields ?? []) {
        if (field.type === "file") {
          const path = ext.settings[field.key];
          if (path) paths.push(path);
        }
      }
    }
    for (const path of paths) {
      if (tableCache.current.has(path)) continue;
      void invoke<string>("read_text_file", { path })
        .then((content) => tableCache.current.set(path, content))
        .catch(() => tableCache.current.set(path, ""));
    }
  }, [extensions]);

  const hasEnabledTranslationProvider = useMemo(
    () => extensions.some((ext) => ext.kind === "translation" && ext.enabled),
    [extensions],
  );

  const translators = useMemo(
    () => extensions.filter((ext) => ext.kind === "translation") as TranslationExtension[],
    [extensions],
  );

  const activeTranslator = useMemo(
    () => translators.find((ext) => ext.enabled) ?? null,
    [translators],
  );

  const activeTranslators = useMemo(
    () => translators.filter((ext) => ext.enabled),
    [translators],
  );

  const updateExtension = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setExtensions(
        extensions.map((ext) => (ext.id === id ? ({ ...ext, ...patch } as Extension) : ext)),
      );
    },
    [extensions, setExtensions],
  );

  const moveExtension = useCallback(
    (id: string, dir: -1 | 1) => {
      const index = extensions.findIndex((ext) => ext.id === id);
      const target = index + dir;
      if (index < 0 || target < 0 || target >= extensions.length) return;
      const next = [...extensions];
      [next[index], next[target]] = [next[target], next[index]];
      setExtensions(next);
    },
    [extensions, setExtensions],
  );

  const addExtension = useCallback(
    (kind: "translation" | "tool", providerOrTool: string) => {
      if (kind === "translation") {
        const def = TRANSLATOR_DEFS.find((d) => d.id === providerOrTool);
        const ext: TranslationExtension = {
          id: `${providerOrTool}-${Date.now()}`,
          nameKey: def?.nameKey ?? "extensions.google",
          enabled: false,
          kind: "translation",
          provider: providerOrTool,
          sourceLanguage: def?.defaultSource ?? "auto",
          targetLanguage: def?.defaultTarget ?? "en",
          settings: {},
        };
        setExtensions([...extensions, ext]);
      } else {
        const def = TOOL_DEFS.find((d) => d.id === providerOrTool);
        const ext: ToolExtension = {
          id: `${providerOrTool}-${Date.now()}`,
          nameKey: def?.nameKey ?? "extensions.regexFilter",
          enabled: false,
          kind: "tool",
          tool: providerOrTool,
          settings: {},
        };
        setExtensions([...extensions, ext]);
      }
    },
    [extensions, setExtensions],
  );

  const removeExtension = useCallback(
    (id: string) => {
      setExtensions(extensions.filter((ext) => ext.id !== id));
    },
    [extensions, setExtensions],
  );

  const applyTool = useCallback(
    (text: string, ext: ToolExtension, threadId?: string): string => {
      const settings = ext.settings ?? {};
      const key = threadId || "__default__";
      switch (ext.tool) {
        case "regex-filter": {
          const pattern = (settings.pattern ?? "").trim();
          const filePath = settings.filePath ?? "";
          let result = text;
          if (filePath) {
            const content = tableCache.current.get(filePath) ?? "";
            for (const line of content.split(/\r?\n/)) {
              const p = line.trim();
              if (p) {
                try {
                  result = result.replace(new RegExp(p, "g"), "");
                } catch {
                  // 忽略非法正则。
                }
              }
            }
          }
          if (pattern) {
            try {
              result = result.replace(new RegExp(pattern, "g"), "");
            } catch {
              // 忽略非法正则。
            }
          }
          return result;
        }
        case "regex-replacer": {
          const pattern = (settings.pattern ?? "").trim();
          const replacement = settings.replacement ?? "";
          if (!pattern) return text;
          try {
            return text.replace(new RegExp(pattern, "g"), replacement);
          } catch {
            return text;
          }
        }
        case "remove-repeated-chars":
          return removeRepeatedChars(text);
        case "remove-repeated-leading-sentence":
          return removeRepeatedLeadingSentence(text, key);
        case "remove-repeat-phrase":
          return removeRepeatPhrase(text);
        case "remove-repeat-sentence": {
          const size = Number(settings.cacheSize ?? "30") || 30;
          return removeRepeatSentence(text, key, size);
        }
        case "replacer": {
          const filePath = settings.filePath ?? "";
          if (!filePath) return text;
          const content = tableCache.current.get(filePath) ?? "";
          return applyReplacementTable(text, parseReplacementTable(content));
        }
        case "replacer-language-chars": {
          const filePath = settings.filePath ?? "";
          if (filePath) {
            const content = tableCache.current.get(filePath) ?? "";
            if (content) return applyReplacementTable(text, parseReplacementTable(content));
          }
          return applyReplacementTable(text, DEFAULT_LANGUAGE_CHAR_TABLE);
        }
        default:
          return text;
      }
    },
    [],
  );

  const filterOriginal = useCallback(
    (text: string, threadId?: string): string => {
      let result = text;
      for (const ext of extensions) {
        if (ext.kind !== "tool" || !ext.enabled) continue;
        if (ext.tool === "copy-clipboard") continue; // 副作用工具，不改文本。
        result = applyTool(result, ext, threadId);
      }
      return result;
    },
    [extensions, applyTool],
  );

  const filterTranslation = useCallback(
    (text: string): string => {
      let result = text;
      for (const ext of extensions) {
        if (ext.kind !== "tool" || !ext.enabled) continue;
        if (ext.tool !== "regex-replacer-translated") continue;
        result = applyTool(result, ext);
      }
      return result;
    },
    [extensions, applyTool],
  );

  const runSideEffectTools = useCallback(
    (text: string, threadId?: string) => {
      const key = threadId || "__default__";
      for (const ext of extensions) {
        if (ext.kind !== "tool" || !ext.enabled) continue;
        if (ext.tool !== "copy-clipboard") continue;
        if (key === "clipboard") continue; // 避免剪切板线程自我循环。
        if (isTauri()) {
          void invoke("copy_to_clipboard", { text }).catch(() => {});
        } else {
          void navigator.clipboard.writeText(text).catch(() => {});
        }
      }
    },
    [extensions],
  );

  const translateWith = useCallback(
    async (
      text: string,
      translator?: TranslationExtension,
      context?: string[],
      skipCache = false,
    ): Promise<TranslateOutcome> => {
      if (!isTauri()) throw new Error("Translation is not available in the browser.");
      const t = translator ?? translators.find((ext) => ext.enabled);
      if (!t) throw new Error("No translation provider is enabled.");
      const result = await invoke<{ translation: string; fromCache: boolean }>("translate_text", {
        request: {
          provider: t.provider,
          source: t.sourceLanguage,
          target: t.targetLanguage,
          text,
          settings: t.settings ?? {},
          timeoutMs: translateTimeoutMs,
          context: context ?? [],
          skipCache,
        },
      });
      return { translation: result.translation, fromCache: result.fromCache, provider: t.provider };
    },
    [translators, translateTimeoutMs],
  );

  const translate = useCallback(
    (text: string): Promise<TranslateOutcome> => translateWith(text, activeTranslator ?? undefined),
    [translateWith, activeTranslator],
  );

  const romanizeJa = useCallback(
    async (text: string): Promise<string | null> => {
      if (!isTauri()) return null;
      const enabled = extensions.some(
        (ext) => ext.kind === "tool" && ext.tool === "romanji" && ext.enabled,
      );
      if (!enabled || text.trim() === "") return null;
      try {
        return await invoke<string>("romanize_ja", { text });
      } catch {
        return null;
      }
    },
    [extensions],
  );

  return {
    extensions,
    hasEnabledTranslationProvider,
    activeTranslator,
    activeTranslators,
    translators,
    updateExtension,
    moveExtension,
    addExtension,
    removeExtension,
    filterOriginal,
    filterTranslation,
    runSideEffectTools,
    translate,
    translateWith,
    romanizeJa,
  };
}
