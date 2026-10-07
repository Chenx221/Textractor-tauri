import { useCallback, useEffect, useState } from "react";
import { Box, Button, CircularProgress, Divider, Typography } from "@mui/material";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useHost } from "../host/HostContext";

/** 与 Rust `RomanjiDictStatus` 对应（字段名为原样 snake_case）。 */
interface DictStatus {
  installed: boolean;
  path: string;
  size_bytes: number;
  version: string;
  /** 已安装但版本与应用所需的不一致（或文件不完整）→ 需要重新下载。 */
  outdated: boolean;
  /** 已安装但加载失败的原因（格式不匹配/文件损坏等）。 */
  load_error: string | null;
  /** 自定义词典（txt）路径。 */
  user_dict_path: string | null;
  /** 自定义词典文件是否已存在。 */
  user_dict_exists: boolean;
  /** 自定义词典中生效的词条数。 */
  user_dict_entries: number;
  /** 自定义词典解析/加载失败的原因。 */
  user_dict_error: string | null;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * 罗马音（IPADIC）词典的安装状态与安装/删除操作。
 *
 * 词典体积较大（约 46MB），不再内嵌进可执行文件，改为按需下载 lindera 官方
 * 的预编译包并解压到数据目录，再由后端动态加载；未安装时“罗马音标注”不可用。
 *
 * 另有自定义词典（txt）：IPADIC 对固有名词经常断词/注音错误，用户可按
 * 「表记　读音」逐行补充，词条优先于内置词典。
 */
export function RomanjiDictPanel() {
  const { t } = useTranslation();
  const { reromanizeAll } = useHost();
  const [status, setStatus] = useState<DictStatus | null>(null);
  const [pending, setPending] = useState<"" | "install" | "userDict">("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    if (!isTauri()) return;
    void invoke<DictStatus>("romanji_dict_status")
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 后端在下载/解压阶段会发事件（无法给出字节级进度，用阶段提示即可）。
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ stage: string }>("romanji-dict-progress", (event) => {
      if (event.payload.stage === "done") {
        setPending("");
        refresh();
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

  const install = () => {
    setError("");
    setPending("install");
    void invoke("romanji_dict_install")
      .then(() => {
        setPending("");
        refresh();
      })
      .catch((err: unknown) => {
        setPending("");
        setError(String(err));
      });
  };

  const remove = () => {
    setError("");
    void invoke("romanji_dict_uninstall")
      .then(refresh)
      .catch((err: unknown) => setError(String(err)));
  };

  /** 用默认编辑器打开自定义词典（文件不存在时后端先写入模板）。 */
  const openUserDict = () => {
    setError("");
    setPending("userDict");
    void invoke<string>("romanji_user_dict_open")
      .then(() => refresh())
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setPending(""));
  };

  /** 重新加载词典 + 自定义词典，并刷新已显示文本的罗马音。 */
  const reloadUserDict = () => {
    setError("");
    setPending("userDict");
    void invoke("romanji_user_dict_reload")
      .then(() => reromanizeAll())
      .then(() => refresh())
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setPending(""));
  };

  const sizeMb = status ? Math.round(status.size_bytes / (1024 * 1024)) : 0;
  // 已安装但需重新下载（版本不匹配 / 文件不完整 / 加载失败）。
  const needsReinstall =
    status?.installed === true && (status.outdated || status.load_error !== null);


  const statusText = !status
    ? ""
    : !status.installed
      ? t("extensions.romanjiDictMissing")
      : status.outdated
        ? t("extensions.romanjiDictOutdated")
        : status.load_error !== null
          ? t("extensions.romanjiDictLoadFailed")
          : t("extensions.romanjiDictInstalled", { size: sizeMb });

  return (
    <Box sx={{ mt: 1, p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
      <Typography variant="body2">{t("extensions.romanjiDictTitle")}</Typography>
      <Typography
        variant="caption"
        color={needsReinstall ? "warning.main" : "text.secondary"}
        sx={{ display: "block", mt: 0.25 }}
      >
        {statusText}
      </Typography>
      {status && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", wordBreak: "break-all", opacity: 0.8 }}
        >
          {t("extensions.romanjiDictPath", { path: status.path })}
        </Typography>
      )}

      {pending !== "" && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
          <CircularProgress size={12} />
          <Typography variant="caption" color="text.secondary">
            {pending === "install"
              ? t("extensions.romanjiDictInstalling")
              : t("extensions.romanjiUserDictReloading")}
          </Typography>
        </Box>
      )}

      {error !== "" && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ display: "block", mt: 0.5, wordBreak: "break-word" }}
        >
          {t("extensions.romanjiDictFailed", { error })}
        </Typography>
      )}

      {/* 加载失败的原始原因（技术信息，便于排查）。 */}
      {status?.load_error != null && error === "" && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 0.5, wordBreak: "break-word", opacity: 0.8 }}
        >
          {status.load_error}
        </Typography>
      )}

      <Box sx={{ display: "flex", gap: 1, mt: 0.75 }}>
        {!status?.installed && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadOutlinedIcon fontSize="small" />}
            disabled={pending !== ""}
            onClick={install}
          >
            {t("extensions.romanjiDictInstall")}
          </Button>
        )}
        {needsReinstall && (
          <Button
            size="small"
            variant="outlined"
            color="warning"
            startIcon={<DownloadOutlinedIcon fontSize="small" />}
            disabled={pending !== ""}
            onClick={install}
          >
            {t("extensions.romanjiDictRedownload")}
          </Button>
        )}
        {status?.installed && (
          <Button
            size="small"
            color="error"
            startIcon={<DeleteOutlinedIcon fontSize="small" />}
            disabled={pending !== ""}
            onClick={remove}
          >
            {t("extensions.romanjiDictRemove")}
          </Button>
        )}
      </Box>

      <Divider sx={{ my: 1 }} />

      {/* 自定义词典：纠正 IPADIC 对固有名词的断词/注音（如人名「刀哉」）。 */}
      <Typography variant="body2">{t("extensions.romanjiUserDictTitle")}</Typography>
      <Typography
        variant="caption"
        color={status?.user_dict_error != null ? "warning.main" : "text.secondary"}
        sx={{ display: "block", mt: 0.25 }}
      >
        {status?.user_dict_exists !== true
          ? t("extensions.romanjiUserDictMissing")
          : t("extensions.romanjiUserDictEntries", { entries: status?.user_dict_entries ?? 0 })}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 0.25, opacity: 0.8 }}
      >
        {t("extensions.romanjiUserDictFormat")}
      </Typography>
      {status?.user_dict_path != null && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", wordBreak: "break-all", opacity: 0.8 }}
        >
          {t("extensions.romanjiDictPath", { path: status.user_dict_path })}
        </Typography>
      )}
      {status?.user_dict_error != null && (
        <Typography
          variant="caption"
          color="error.main"
          sx={{ display: "block", mt: 0.5, wordBreak: "break-word" }}
        >
          {t("extensions.romanjiUserDictError", { error: status.user_dict_error })}
        </Typography>
      )}

      <Box sx={{ display: "flex", gap: 1, mt: 0.75 }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<EditOutlinedIcon fontSize="small" />}
          disabled={pending !== ""}
          onClick={openUserDict}
        >
          {t("extensions.romanjiUserDictEdit")}
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshOutlinedIcon fontSize="small" />}
          disabled={pending !== ""}
          onClick={reloadUserDict}
        >
          {t("extensions.romanjiUserDictReload")}
        </Button>
      </Box>
    </Box>
  );
}
