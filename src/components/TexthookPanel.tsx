import { useEffect, useRef } from "react";
import {
  Box,
  Button,
  Chip,
  Divider,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { isAdminError, useTexthook } from "../hooks/useTexthook";

/**
 * “关于”对话框里的 texthook 组件区块。
 *
 * 上游 Chenx221/Textractor 每次发版都会更新 texthook.dll，这里可以单独更新它，
 * 不必为了 texthook 再发一版应用本体。载入的就是 exe 同级目录那份 dll ——
 * 更新时若该目录不可写（安装在 Program Files），会提示以管理员身份重启。
 */
export function TexthookPanel() {
  const { t } = useTranslation();
  const { status, checkResult, checking, busy, error, check, update, restartAsAdmin } =
    useTexthook();
  const startedRef = useRef(false);

  // 打开时自动查一次（24h 内已查过就直接用缓存，不会真的打 API）。
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void check(false);
  }, [check]);

  const currentText = !status
    ? ""
    : status.tag === null
      ? t("about.texthook.currentUnknown")
      : status.source === "installed"
        ? t("about.texthook.currentInstalled", { version: status.tag })
        : t("about.texthook.currentBundled", { version: status.tag });

  const needsAdmin = (status !== null && !status.writable) || isAdminError(error);

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Stack spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="subtitle2">{t("about.texthook.title")}</Typography>
        {currentText !== "" && (
          <Typography variant="body2" color="text.secondary">
            {currentText}
          </Typography>
        )}
        {status && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", wordBreak: "break-all", opacity: 0.75 }}
          >
            {status.dll_path}
          </Typography>
        )}

        {checking && (
          <Typography variant="body2" color="text.secondary">
            {t("about.texthook.checking")}
          </Typography>
        )}
        {!checking && checkResult && !checkResult.has_update && (
          <Chip size="small" color="success" variant="outlined" label={t("about.texthook.upToDate")} />
        )}
        {!checking && checkResult && checkResult.has_update && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={t("about.texthook.available", { version: checkResult.tag })}
          />
        )}

        {busy && (
          <>
            <Typography variant="body2" color="text.secondary">
              {t("about.texthook.working")}
            </Typography>
            <LinearProgress variant="indeterminate" sx={{ width: "100%" }} />
          </>
        )}

        {checkResult?.has_update && checkResult.notes !== "" && !busy && (
          <Box
            sx={{
              width: "100%",
              maxHeight: 120,
              overflow: "auto",
              textAlign: "left",
              bgcolor: "action.hover",
              borderRadius: 1,
              p: 1,
            }}
          >
            <Typography
              variant="caption"
              component="pre"
              sx={{ whiteSpace: "pre-wrap", fontFamily: "inherit", m: 0 }}
            >
              {checkResult.notes}
            </Typography>
          </Box>
        )}

        {error !== "" && (
          <Typography variant="body2" color="error" sx={{ wordBreak: "break-word" }}>
            {error === "RESTART_UNAVAILABLE"
              ? t("titlebar.restartUnavailable")
              : t("about.texthook.error", { error })}
          </Typography>
        )}

        {needsAdmin && !busy && (
          <Typography variant="caption" color="warning.main" sx={{ textAlign: "center" }}>
            {t("about.texthook.needsAdmin")}
          </Typography>
        )}

        <Stack direction="row" spacing={1}>
          {checkResult?.has_update && (
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void update(checkResult.tag)}
            >
              {t("about.texthook.update", { version: checkResult.tag })}
            </Button>
          )}
          {!busy && !checking && (
            <Button size="small" variant="text" onClick={() => void check(true)}>
              {t("about.texthook.check")}
            </Button>
          )}
          {needsAdmin && !busy && (
            <Button size="small" variant="outlined" onClick={() => void restartAsAdmin()}>
              {t("about.texthook.restartAdmin")}
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
