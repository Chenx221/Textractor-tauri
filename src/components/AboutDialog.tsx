import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Snackbar,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { UpdatePanel } from "./UpdatePanel";
import { TexthookPanel } from "./TexthookPanel";

interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

interface BuildInfo {
  profile: string;
  version: string;
  arch: string;
  built_at: string;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 连点次数达到该值即打开开发者工具（Android 彩蛋风格）。 */
const DEVTOOLS_CLICKS = 5;
/** 第几次点击后开始显示“还差几次”的提示。 */
const HINT_FROM_CLICK = 2;

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = useTranslation();
  const [clickCount, setClickCount] = useState(0);
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [hintOpen, setHintOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setClickCount(0);
      setHintOpen(false);
      return;
    }
    if (isTauri()) {
      void invoke<BuildInfo>("get_build_info").then(setBuildInfo).catch(() => {});
    }
  }, [open]);

  /** 连点彩蛋：第 2 次起提示还差几次，第 5 次打开开发者工具（Android 风格）。 */
  const handleLogoClick = () => {
    setClickCount((prev) => {
      const next = prev + 1;
      if (next >= DEVTOOLS_CLICKS) {
        setHintOpen(false);
        if (isTauri()) {
          void invoke("open_devtools").catch(() => {});
        }
        return 0;
      }
      setHintOpen(next >= HINT_FROM_CLICK);
      return next;
    });
  };

  const profile = buildInfo?.profile ?? (import.meta.env.PROD ? "release" : "debug");
  const remaining = Math.max(0, DEVTOOLS_CLICKS - clickCount);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t("about.title")}</DialogTitle>
      <DialogContent sx={{ textAlign: "center" }}>
        <Box sx={{ display: "flex", justifyContent: "center", my: 2 }}>
          <IconButton
            onClick={handleLogoClick}
            aria-label={t("app.title")}
            sx={{
              width: 96,
              height: 96,
              borderRadius: 3,
              bgcolor: "primary.main",
              color: "#fff",
              "&:hover": { bgcolor: "primary.dark" },
            }}
          >
            {/* 应用标识：字母 T（原先误用了 Google 翻译的图标）。 */}
            <Typography
              component="span"
              sx={{ fontSize: 56, fontWeight: 700, lineHeight: 1, letterSpacing: "-0.04em" }}
            >
              T
            </Typography>
          </IconButton>
        </Box>

        <Typography variant="h6">{t("app.title")}</Typography>
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            {t("about.version")}: {buildInfo?.version ?? "—"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("about.profile")}: {profile}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("about.arch")}: {buildInfo?.arch ?? "—"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("about.builtAt")}: {buildInfo?.built_at ?? "—"}
          </Typography>
        </Box>

        <UpdatePanel />
        <TexthookPanel />
      </DialogContent>

      <Snackbar
        open={hintOpen}
        autoHideDuration={3000}
        onClose={() => setHintOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity="info"
          variant="filled"
          sx={{ width: "100%" }}
          onClose={() => setHintOpen(false)}
        >
          {t("about.clickHint", { count: remaining })}
        </Alert>
      </Snackbar>
    </Dialog>
  );
}
