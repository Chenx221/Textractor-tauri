import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 与 Rust `TexthookStatus` 对应（字段名为原样 snake_case）。 */
export interface TexthookStatus {
  /** exe 所在目录。 */
  dir: string;
  /** x64 texthook.dll 路径。 */
  dll_path: string;
  /** x86 texthook.dll 路径。 */
  x86_dll_path: string;
  /** 当前生效版本（无法判断时为 null）。 */
  tag: string | null;
  /** `installed`（运行时更新过）/ `bundled`（随程序自带）/ `unknown`。 */
  source: "installed" | "bundled" | "unknown";
  /** exe 目录是否可写；false 表示更新需要管理员权限。 */
  writable: boolean;
  upstream_tag: string | null;
  last_check: number;
}

/** 与 Rust `TexthookCheck` 对应。 */
export interface TexthookCheck {
  tag: string;
  asset: string;
  size: number;
  url: string;
  current_tag: string | null;
  has_update: boolean;
  notes: string;
  /** 结果来自 24h 缓存（未联网）。 */
  cached: boolean;
  writable: boolean;
}

export type TexthookStage = "downloading" | "extracting" | "installing" | "done";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 错误信息里带 `NEED_ADMIN` 前缀表示需要提权后才能就地替换。 */
export function isAdminError(error: string): boolean {
  return error.includes("NEED_ADMIN");
}

/**
 * 启动时的静默检查（带 24h 节流）：只有确实有更新时才返回新版本号。
 * 未联网 / 未配置 / 开发环境等一律静默返回 null，不打扰用户。
 */
export async function checkTexthookSilently(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const result = await invoke<TexthookCheck>("texthook_check", { force: false });
    return result.has_update ? result.tag : null;
  } catch {
    return null;
  }
}

/**
 * texthook.dll 的运行时更新（x64 + x86）。
 *
 * 上游 `Chenx221/Textractor` 每次发版都会更新 texthook，这里允许应用内单独更新它，
 * 不必因为 texthook 就再发一版应用。载入的 dll 就是 exe 同级目录那一份，替换后
 * 重新附加游戏即可生效（更新前会自动分离已附加的进程，避免文件被占用）。
 */
export function useTexthook() {
  const [status, setStatus] = useState<TexthookStatus | null>(null);
  const [checkResult, setCheckResult] = useState<TexthookCheck | null>(null);
  const [stage, setStage] = useState<TexthookStage | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!isTauri()) return null;
    try {
      const next = await invoke<TexthookStatus>("texthook_status");
      setStatus(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 后端按阶段发事件（下载 → 解压 → 替换 → 完成）。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ stage: TexthookStage }>("texthook-update-progress", (event) => {
      if (disposed) return;
      setStage(event.payload.stage);
      if (event.payload.stage === "done") {
        setBusy(false);
        setCheckResult(null);
        void refresh();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  /** 检查上游是否有更新；`force = false` 时可能直接走 24h 缓存。 */
  const check = useCallback(async (force = true) => {
    if (!isTauri()) return null;
    setChecking(true);
    setError("");
    try {
      const result = await invoke<TexthookCheck>("texthook_check", { force });
      setCheckResult(result);
      return result;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  /** 下载并就地更新（tag 为空 = 上游最新）。 */
  const update = useCallback(
    async (tag?: string) => {
      if (!isTauri()) return null;
      setBusy(true);
      setStage("downloading");
      setError("");
      try {
        const result = await invoke<{ tag: string }>("texthook_update", { tag: tag ?? null });
        await refresh();
        return result;
      } catch (e) {
        setError(String(e));
        return null;
      } finally {
        setBusy(false);
        setStage(null);
      }
    },
    [refresh],
  );

  /** 以管理员身份重启（就地更新需要写 exe 目录）。 */
  const restartAsAdmin = useCallback(async () => {
    try {
      await invoke("restart_as_admin");
    } catch {
      setError("RESTART_UNAVAILABLE");
    }
  }, []);

  return { status, checkResult, stage, checking, busy, error, check, update, refresh, restartAsAdmin };
}
