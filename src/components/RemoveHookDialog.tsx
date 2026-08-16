import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Typography,
} from "@mui/material";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface HookInfo {
  code: string;
  address: number;
  is_engine?: boolean;
  name?: string;
}

interface RemoveHookDialogProps {
  open: boolean;
  pid: number | null;
  onClose: () => void;
  onRemove: (address: number) => void;
}

export function RemoveHookDialog({ open, pid, onClose, onRemove }: RemoveHookDialogProps) {
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<HookInfo[]>([]);

  const refresh = useCallback(() => {
    if (pid === null) {
      setHooks([]);
      return;
    }
    void invoke<HookInfo[]>("list_hooks", { pid })
      .then(setHooks)
      .catch(() => setHooks([]));
  }, [pid]);

  useEffect(() => {
    if (!open || pid === null) {
      setHooks([]);
      return;
    }
    refresh();
  }, [open, pid, refresh]);

  // 移除 hook 是异步往返（宿主→DLL→宿主确认），只有收到 host-hook-removed
  // 事件才代表 DLL 已完成移除，此时再刷新列表。
  useEffect(() => {
    if (!open || pid === null) return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ pid: number; address: number }>("host-hook-removed", () => {
      if (!disposed) refresh();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open, pid, refresh]);

  const handleRemove = (address: number) => {
    onRemove(address);
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("sidebar.actions.removeHook")}</DialogTitle>
      <DialogContent>
        {hooks.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("hook.noHooks")}
          </Typography>
        ) : (
          <List dense>
            {hooks.map((hook) => (
              <ListItem
                key={hook.address}
                secondaryAction={
                  <IconButton edge="end" size="small" onClick={() => handleRemove(hook.address)}>
                    <DeleteOutlinedIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemText
                  primary={hook.name || hook.code}
                  secondary={hook.name ? hook.code : undefined}
                />
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("attach.cancel")}</Button>
      </DialogActions>
    </Dialog>
  );
}
