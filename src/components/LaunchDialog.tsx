import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

interface LaunchDialogProps {
  open: boolean;
  onClose: () => void;
  onLaunched: (path: string) => void;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function LaunchDialog({ open, onClose, onLaunched }: LaunchDialogProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");

  const handleBrowse = async () => {
    if (!isTauri()) return;
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Executable", extensions: ["exe"] }],
      });
      if (typeof selected === "string") setPath(selected);
    } catch {
      // ignore
    }
  };

  const handleLaunch = () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    if (isTauri()) {
      void invoke("launch_game", { path: trimmed }).catch(() => {});
    }
    onLaunched(trimmed);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("launch.title")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t("launch.hint")}
        </Typography>
        <Box sx={{ display: "flex", gap: 1 }}>
          <TextField
            size="small"
            fullWidth
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("launch.pathPlaceholder")}
          />
          <Button variant="outlined" onClick={handleBrowse} startIcon={<FolderOpenIcon />}>
            {t("launch.browse")}
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("launch.cancel")}</Button>
        <Button onClick={handleLaunch} disabled={!path.trim()} variant="contained">
          {t("launch.launch")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
