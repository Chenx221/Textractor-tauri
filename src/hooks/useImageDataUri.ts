import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * 把图片路径（本地文件路径 / data URI / blob / http URL）解析为可直接用于
 * CSS `backgroundImage` 的值。本地文件通过 Rust `read_image_data_uri` 读取为 data URI。
 */
export function useImageDataUri(path: string): string {
  const [uri, setUri] = useState("");

  useEffect(() => {
    let cancelled = false;
    const trimmed = (path ?? "").trim();
    if (!trimmed) {
      setUri("");
      return;
    }
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://")
    ) {
      setUri(trimmed);
      return;
    }
    if (!isTauri()) {
      setUri("");
      return;
    }
    void invoke<string>("read_image_data_uri", { path: trimmed })
      .then((value) => {
        if (!cancelled) setUri(value);
      })
      .catch(() => {
        if (!cancelled) setUri("");
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return uri;
}
