import { useCallback, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";

/** 更新流程状态。 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "done"
  | "error";

export interface UpdateInfo {
  /** 服务器公布的新版本号。 */
  version: string;
  /** 当前运行版本号。 */
  currentVersion: string;
  /** 发布时间（RFC 3339）。 */
  date?: string;
  /** 发布说明。 */
  body?: string;
}

export interface UseUpdaterResult {
  status: UpdateStatus;
  info: UpdateInfo | null;
  /** 下载进度（0-100，仅在 downloading 时有意义）。 */
  progress: number;
  error: string | null;
  checkForUpdates: () => Promise<UpdateInfo | null>;
  installUpdate: () => Promise<void>;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 后台静默检查（启动时用）：只返回新版本号，并立刻释放插件持有的后端资源。
 * 出错时静默返回 null（未联网 / 未配置公钥 / 开发环境等都不应打扰用户）。
 */
export async function checkForUpdateVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    const version = update.version;
    await update.close();
    return version;
  } catch {
    return null;
  }
}

/**
 * 应用内更新（tauri-plugin-updater）。
 * 端点在 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints` 配置，
 * 指向 GitHub Release 上的 `latest.json`。
 */
export function useUpdater(): UseUpdaterResult {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);

  const checkForUpdates = useCallback(async () => {
    if (!isTauri()) {
      setStatus("error");
      setError("Updates are only available in the desktop app.");
      return null;
    }
    setStatus("checking");
    setError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      updateRef.current = update;
      if (!update) {
        setInfo(null);
        setStatus("upToDate");
        return null;
      }
      const next: UpdateInfo = {
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date,
        body: update.body,
      };
      setInfo(next);
      setStatus("available");
      return next;
    } catch (e) {
      updateRef.current = null;
      setInfo(null);
      setError(messageOf(e));
      setStatus("error");
      return null;
    }
  }, []);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setError(null);
    setProgress(0);
    setStatus("downloading");
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(
              total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
            );
            break;
          case "Finished":
            setStatus("installing");
            break;
        }
      });
      // Windows 上安装器会在这之前就把应用退出；能走到这里说明需要自行重启。
      setProgress(100);
      setStatus("done");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      setError(messageOf(e));
      setStatus("error");
    }
  }, []);

  return { status, info, progress, error, checkForUpdates, installUpdate };
}
