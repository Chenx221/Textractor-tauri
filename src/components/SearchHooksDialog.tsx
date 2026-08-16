import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import type { SearchParam } from "../host/HostContext";

type SearchMode = "auto" | "text" | "custom";

interface SearchHooksDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (param: SearchParam) => void;
}

export function SearchHooksDialog({ open, onClose, onSubmit }: SearchHooksDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SearchMode>("auto");
  const [text, setText] = useState("");
  const [codepage, setCodepage] = useState("932");
  const [pattern, setPattern] = useState("");
  const [offset, setOffset] = useState("0");
  const [searchTime, setSearchTime] = useState("30000");
  const [maxRecords, setMaxRecords] = useState("100000");
  const [module, setModule] = useState("");

  const intOr = (value: string, fallback: number) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const submit = () => {
    onSubmit({
      text: mode === "text" ? text.trim() : "",
      codepage: intOr(codepage, 932),
      pattern: mode === "custom" ? pattern.trim() : "",
      offset: mode === "custom" ? intOr(offset, 0) : 0,
      searchTime: intOr(searchTime, 30000),
      maxRecords: intOr(maxRecords, 100000),
      module: mode === "custom" ? module.trim() : "",
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("sidebar.actions.searchHooks")}</DialogTitle>
      <DialogContent>
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {t("search.warning")}
        </Alert>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <FormControl size="small" fullWidth>
            <InputLabel>{t("search.mode")}</InputLabel>
            <Select value={mode} label={t("search.mode")} onChange={(e) => setMode(e.target.value as SearchMode)}>
              <MenuItem value="auto">{t("search.modeAuto")}</MenuItem>
              <MenuItem value="text">{t("search.modeText")}</MenuItem>
              <MenuItem value="custom">{t("search.modeCustom")}</MenuItem>
            </Select>
          </FormControl>

          {mode === "auto" && (
            <Typography variant="body2" color="text.secondary">
              {t("search.autoHint")}
            </Typography>
          )}

          {mode === "text" && (
            <>
              <TextField
                fullWidth
                size="small"
                label={t("search.text")}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <TextField
                fullWidth
                size="small"
                type="number"
                label={t("search.codepage")}
                value={codepage}
                onChange={(e) => setCodepage(e.target.value)}
              />
            </>
          )}

          {mode === "custom" && (
            <>
              <TextField
                fullWidth
                size="small"
                label={t("search.pattern")}
                placeholder="CC CC 48 89"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
              <TextField
                fullWidth
                size="small"
                label={t("search.module")}
                value={module}
                onChange={(e) => setModule(e.target.value)}
              />
              <Box sx={{ display: "flex", gap: 1.5 }}>
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  label={t("search.offset")}
                  value={offset}
                  onChange={(e) => setOffset(e.target.value)}
                />
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  label={t("search.duration")}
                  value={searchTime}
                  onChange={(e) => setSearchTime(e.target.value)}
                />
                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  label={t("search.maxRecords")}
                  value={maxRecords}
                  onChange={(e) => setMaxRecords(e.target.value)}
                />
              </Box>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("attach.cancel")}</Button>
        <Button variant="contained" onClick={submit}>
          {t("search.start")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
