import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Radio,
  RadioGroup,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import type { ConfigLoadInfo, ConfigPaths } from "../types/config";
import { useConfig } from "../settings/ConfigContext";
import { formatBytes } from "../utils/format";

/** Unix 秒 → 本地时间字符串（0/未知时返回 —）。 */
export function formatStamp(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString();
}

/** 当前是否主窗口（浏览器里恒为 true）。 */
function isMainWindowUi(): boolean {
  if (!("__TAURI_INTERNALS__" in window)) return true;
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

/** 配置文件"出了什么事"的判定，决定要不要额外提示。 */
export function verdictIsSuspicious(info: ConfigLoadInfo | null): boolean {
  if (!info) return false;
  return (
    info.verdict === "missing_after_exit" ||
    info.verdict === "modified_while_closed" ||
    info.verdict === "external_corruption"
  );
}

// --------------------------------------------------------------- 日志窗口 ----

export function ConfigLogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>([]);
  const [paths, setPaths] = useState<ConfigPaths | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [tail, info] = await Promise.all([
        invoke<string[]>("config_log_tail", { lines: 400 }),
        invoke<ConfigPaths>("config_paths"),
      ]);
      setLines(tail);
      setPaths(info);
      setError("");
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{t("configRecovery.logTitle")}</DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-all" }}>
          {paths?.log ?? ""}
        </Typography>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <Box
          component="pre"
          sx={{
            mt: 1,
            mb: 0,
            p: 1.5,
            maxHeight: "60vh",
            overflow: "auto",
            fontSize: 11,
            lineHeight: 1.45,
            bgcolor: "action.hover",
            borderRadius: 1,
            whiteSpace: "pre",
          }}
        >
          {lines.length > 0 ? lines.join("\n") : t("configRecovery.logEmpty")}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void invoke("open_config_dir").catch(() => {})}>
          {t("configRecovery.openDir")}
        </Button>
        <Button onClick={() => void refresh()}>{t("configRecovery.refresh")}</Button>
        <Button variant="contained" onClick={onClose}>
          {t("settings.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ----------------------------------------------------------- 恢复确认窗口 ----

/**
 * 配置损坏 / 丢失时的**阻塞**窗口。
 *
 * 旧行为是"读到坏文件就用默认配置继续，并立刻把默认配置写回去"，等于把用户的
 * 配置一次性抹掉。现在必须由用户选一个来源（备份 / 历史快照 / 默认值）才继续。
 */
export function ConfigRecoveryDialog() {
  const { t } = useTranslation();
  const { loadInfo, configBlocked, acceptDefaults, restoreConfig } = useConfig();
  const [choice, setChoice] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logOpen, setLogOpen] = useState(false);

  const options = useMemo(() => {
    const list: { value: string; label: string; hint?: string }[] = [];
    if (loadInfo?.backup.exists) {
      list.push({
        value: "backup",
        label: t("configRecovery.optionBackup"),
        hint: t("configRecovery.optionBackupHint", {
          time: formatStamp(loadInfo.backup.mtime),
          size: formatBytes(loadInfo.backup.len),
        }),
      });
    }
    for (const item of loadInfo?.history ?? []) {
      if (item.parse !== "ok") continue;
      list.push({
        value: `history:${item.name}`,
        label: t("configRecovery.optionHistory", { stamp: item.stamp }),
        hint: formatBytes(item.len),
      });
      if (list.length >= 5) break;
    }
    list.push({ value: "defaults", label: t("configRecovery.optionDefaults") });
    return list;
  }, [loadInfo, t]);

  const activeChoice = choice ?? options[0]?.value ?? "defaults";
  const needsConfirm = activeChoice === "defaults";

  const submit = async () => {
    if (needsConfirm && !confirmed) return;
    setBusy(true);
    setError("");
    try {
      if (activeChoice === "defaults") await acceptDefaults();
      else await restoreConfig(activeChoice);
      setChoice(null);
      setConfirmed(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const info = loadInfo;
  return (
    <>
      <Dialog
        open={configBlocked && info !== null}
        maxWidth="sm"
        fullWidth
        // 必须显式选择，不允许点蒙层/ESC "顺手"关掉；要退出可以直接关窗口。
        onClose={() => {}}
      >
        <DialogTitle>{t("configRecovery.title")}</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>
            {info?.detail || t("configRecovery.unknown")}
          </Alert>

          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            sx={{ wordBreak: "break-all" }}
          >
            {t("configRecovery.fileLine", { path: info?.path ?? "" })}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {t("configRecovery.fileMeta", {
              size: formatBytes(info?.file.len ?? 0),
              time: formatStamp(info?.file.mtime ?? 0),
              sha: info?.file.sha || "—",
            })}
          </Typography>

          {info?.verdict_detail ? (
            <Alert severity={verdictIsSuspicious(info) ? "warning" : "info"} sx={{ mt: 2 }}>
              {info.verdict_detail}
            </Alert>
          ) : null}

          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
            {t("configRecovery.choose")}
          </Typography>
          <RadioGroup
            value={activeChoice}
            onChange={(e) => {
              setChoice(e.target.value);
              setConfirmed(false);
            }}
          >
            {options.map((opt) => (
              <FormControlLabel
                key={opt.value}
                value={opt.value}
                control={<Radio size="small" />}
                label={
                  <Stack>
                    <Typography variant="body2">{opt.label}</Typography>
                    {opt.hint ? (
                      <Typography variant="caption" color="text.secondary">
                        {opt.hint}
                      </Typography>
                    ) : null}
                  </Stack>
                }
                sx={{ alignItems: "flex-start", mb: 0.5 }}
              />
            ))}
          </RadioGroup>

          {needsConfirm ? (
            <>
              <Alert severity="warning" sx={{ mt: 1 }}>
                {t("configRecovery.defaultsWarning")}
              </Alert>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                }
                label={t("configRecovery.defaultsConfirm")}
                sx={{ mt: 1 }}
              />
            </>
          ) : null}

          {error ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLogOpen(true)}>{t("configRecovery.viewLog")}</Button>
          <Button
            variant="contained"
            disabled={busy || (needsConfirm && !confirmed)}
            onClick={() => void submit()}
          >
            {busy ? t("configRecovery.working") : t("configRecovery.confirm")}
          </Button>
        </DialogActions>
      </Dialog>
      <ConfigLogDialog open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

// ------------------------------------------------------------------ 门禁 ----

/**
 * 包在应用外层：正常时什么都不做；配置需要用户确认时弹阻塞窗口；
 * 判定"配置文件在关机期间被外部改过"时给一条可关闭的提示（附日志入口）。
 */
export function ConfigGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { loadInfo, configBlocked, restoreConfig } = useConfig();
  const [logOpen, setLogOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  const recovered = loadInfo?.status === "recovered";
  const suspicious = verdictIsSuspicious(loadInfo);
  const showNotice = !configBlocked && !noticeDismissed && (recovered || suspicious);

  // 恢复/提示只在主窗口出现：悬浮窗是同一个进程里的第二套 React 树。
  if (!isMainWindowUi()) return <>{children}</>;

  // 文件被外部改过（内容变了但还能解析）时不强制弹窗，但给一个一键回滚。
  const canRollback = suspicious && loadInfo?.backup.exists && !recovered;

  return (
    <>
      {children}
      <ConfigRecoveryDialog />
      <ConfigLogDialog open={logOpen} onClose={() => setLogOpen(false)} />
      <Snackbar
        open={showNotice}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        onClose={() => setNoticeDismissed(true)}
        autoHideDuration={recovered ? 8000 : 20000}
      >
        <Alert
          severity={recovered ? "success" : "warning"}
          variant="filled"
          onClose={() => setNoticeDismissed(true)}
          action={
            <>
              {canRollback ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setNoticeDismissed(true);
                    void restoreConfig("backup").catch(() => {});
                  }}
                >
                  {t("configRecovery.restoreBackup")}
                </Button>
              ) : null}
              <Button color="inherit" size="small" onClick={() => setLogOpen(true)}>
                {t("configRecovery.viewLog")}
              </Button>
            </>
          }
        >
          {recovered
            ? t("configRecovery.recoveredNotice")
            : t("configRecovery.verdictNotice")}
        </Alert>
      </Snackbar>
    </>
  );
}
