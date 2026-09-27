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
import { useUpdater } from "../hooks/useUpdater";

/**
 * “关于”对话框里的更新区块：打开时自动检查一次，发现新版本可原地下载并安装。
 */
export function UpdatePanel() {
  const { t } = useTranslation();
  const { status, info, progress, error, checkForUpdates, installUpdate } = useUpdater();
  const startedRef = useRef(false);

  // 只在打开（挂载）时自动检查一次，之后交给用户手动触发。
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void checkForUpdates();
  }, [checkForUpdates]);

  const inProgress =
    status === "downloading" || status === "installing" || status === "done";

  return (
    <Box sx={{ mt: 2 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Stack spacing={1} sx={{ alignItems: "center" }}>
        {status === "checking" && (
          <Typography variant="body2" color="text.secondary">
            {t("about.update.checking")}
          </Typography>
        )}
        {status === "upToDate" && (
          <Chip size="small" color="success" variant="outlined" label={t("about.update.upToDate")} />
        )}
        {status === "available" && info && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={t("about.update.available", { version: info.version })}
          />
        )}
        {inProgress && (
          <Typography variant="body2" color="text.secondary">
            {status === "downloading" && t("about.update.downloading", { percent: progress })}
            {status === "installing" && t("about.update.installing")}
            {status === "done" && t("about.update.done")}
          </Typography>
        )}
        {inProgress && (
          <LinearProgress
            variant={status === "downloading" ? "determinate" : "indeterminate"}
            value={progress}
            sx={{ width: "100%" }}
          />
        )}
        {status === "available" && info?.body && (
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
              {info.body}
            </Typography>
          </Box>
        )}
        {status === "error" && (
          <Typography variant="body2" color="error" sx={{ wordBreak: "break-word" }}>
            {t("about.update.error", { error })}
          </Typography>
        )}
        <Stack direction="row" spacing={1}>
          {status === "available" && (
            <Button size="small" variant="contained" onClick={() => void installUpdate()}>
              {t("about.update.install")}
            </Button>
          )}
          {!inProgress && status !== "checking" && (
            <Button size="small" variant="text" onClick={() => void checkForUpdates()}>
              {t("about.update.check")}
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  );
}
