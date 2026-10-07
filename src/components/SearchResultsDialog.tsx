import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useHost } from "../host/HostContext";

interface SearchResultsDialogProps {
  open: boolean;
  pid: number | null;
  onClose: () => void;
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function SearchResultsDialog({ open, pid, onClose }: SearchResultsDialogProps) {
  const { t } = useTranslation();
  const { searchResults, insertHook, clearSearchResults } = useHost();

  // 只显示本对话框所属进程的搜索结果：切换目标后不会把其它进程的结果混进来，
  // 否则点一下就会把 A 进程搜到的 hook 插到 B 进程里。
  const results = useMemo(
    () => searchResults.filter((result) => result.pid === pid),
    [searchResults, pid],
  );

  const handleAdd = (code: string) => {
    if (pid !== null) insertHook(pid, code);
  };

  const handleSave = async () => {
    if (!isTauri() || results.length === 0) return;
    const path = await saveDialog({
      defaultPath: "results.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    const content = results.map((r) => `${r.code} => ${r.text}`).join("\n");
    void invoke("save_text_file", { path, content }).catch(() => {});
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t("search.results")}</DialogTitle>
      <DialogContent>
        {results.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("search.noResults")}
          </Typography>
        ) : (
          <List dense sx={{ maxHeight: 420, overflowY: "auto" }}>
            {results.map((result, index) => (
              <ListItemButton key={index} onClick={() => handleAdd(result.code)}>
                <ListItemText primary={result.code} secondary={result.text} />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={clearSearchResults}>{t("search.clear")}</Button>
        <Button
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={results.length === 0}
        >
          {t("search.saveResults")}
        </Button>
        <Button variant="contained" onClick={onClose}>
          {t("settings.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
