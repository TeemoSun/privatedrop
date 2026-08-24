import { useCallback, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";

import { api } from "../lib/api";
import { cn, formatBytes, sha256Hex } from "../lib/utils";
import { Button } from "./ui/Button";
import { Spinner } from "./ui/Misc";

const maxFileSize = 5 * 1024 * 1024 * 1024;

interface PendingFile {
  file: File;
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

interface DropZoneProps {
  onCreated: () => void;
}

function putWithProgress(
  target: { upload_url: string; checksum_sha256: string; content_disposition: string },
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", target.upload_url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-amz-checksum-sha256", target.checksum_sha256);
    xhr.setRequestHeader("Content-Disposition", target.content_disposition);
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.onabort = () => reject(new Error("已取消"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`上传失败（HTTP ${xhr.status}）`));
    };
    xhr.send(file);
  });
}

export function DropZone({ onCreated }: DropZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((list: FileList | File[]) => {
    const next = Array.from(list)
      .filter((f) => f.size > 0)
      .map((f) => ({ file: f, progress: 0, status: "uploading" as const }));
    if (!next.length) return;
    const oversized = next.filter((f) => f.file.size > maxFileSize);
    if (oversized.length) {
      setError(`文件超过大小上限（${formatBytes(maxFileSize)}）：${oversized.map((f) => f.file.name).join("、")}`);
      return;
    }
    setFiles((prev) => [...prev, ...next]);
    setError(null);
  }, []);

  const startUpload = useCallback(async () => {
    if (!files.length || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const specs = await Promise.all(
        files.map(async (f) => ({
          file_name: f.file.name,
          mime_type: f.file.type || "application/octet-stream",
          size: f.file.size,
          sha256: await sha256Hex(f.file),
        })),
      );
      const created = await api.createFileItem(specs, note.trim() || null);
      let allOk = true;
      const uploads = created.files.map(async (target, i) => {
        try {
          await putWithProgress(target, files[i].file, (pct) => {
            setFiles((prev) => prev.map((p, idx) => (idx === i ? { ...p, progress: pct } : p)));
          });
          setFiles((prev) => prev.map((p, idx) => (idx === i ? { ...p, status: "done", progress: 100 } : p)));
        } catch (e) {
          allOk = false;
          setFiles((prev) =>
            prev.map((p, idx) => (idx === i ? { ...p, status: "error", error: (e as Error).message } : p)),
          );
        }
      });
      await Promise.all(uploads);

      if (!allOk) {
        setError("部分文件上传失败，未完成条目将在 1 小时后自动清理");
        return;
      }
      await api.uploadComplete(created.item_id);
      onCreated();
      setFiles([]);
      setNote("");
    } catch (e) {
      if (e instanceof Error) {
        setError(e.message || "创建条目失败");
      }
    } finally {
      setSubmitting(false);
    }
  }, [files, note, submitting, onCreated]);

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragActive ? "border-primary bg-accent" : "border-muted-foreground/30 hover:border-primary/60",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <FileUp className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">拖拽文件到这里，或点击选择</p>
        <p className="text-xs text-muted-foreground">上传将直连存储，支持大文件</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(f.file.size)}</p>
              </div>
              {f.status === "uploading" && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${f.progress}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{f.progress}%</span>
                </div>
              )}
              {f.status === "done" && <span className="text-xs text-green-600">已完成</span>}
              {f.status === "error" && <span className="text-xs text-destructive">{f.error ?? "失败"}</span>}
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {submitting && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner /> 正在上传…
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" disabled={submitting} onClick={startUpload}>
            上传{files.length > 0 ? `（${files.length}）` : ""}
          </Button>
        </div>
      )}
    </div>
  );
}
