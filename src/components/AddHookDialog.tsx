import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";

interface AddHookDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (code: string) => void;
}

export function AddHookDialog({ open, onClose, onSubmit }: AddHookDialogProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");

  useEffect(() => {
    if (open) setCode("");
  }, [open]);

  const submit = () => {
    const value = code.trim();
    if (!value) return;
    onSubmit(value);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg">
      <DialogTitle>{t("sidebar.actions.addHook")}</DialogTitle>
      <DialogContent>
        <Typography
          variant="caption"
          component="pre"
          sx={{
            whiteSpace: "pre-wrap",
            fontFamily: '"Consolas", "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.5,
            color: "text.secondary",
            bgcolor: "background.default",
            border: 1,
            borderColor: "divider",
            borderRadius: 1,
            p: 1.5,
            mb: 2,
          }}
        >
          {t("hook.info")}
        </Typography>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label={t("hook.code")}
          value={code}
          placeholder="/HQN932#...@addr"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("attach.cancel")}</Button>
        <Button variant="contained" onClick={submit} disabled={!code.trim()}>
          {t("attach.ok")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
