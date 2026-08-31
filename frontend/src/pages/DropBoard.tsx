import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, File as FileIcon, FileUp, Inbox, Plus, X } from "lucide-react";

import { api, getAccessToken } from "../lib/api";
import { ItemCard } from "../components/ItemCard";
import { Button } from "../components/ui/Button";
import { EmptyState, Spinner } from "../components/ui/Misc";
import { Textarea } from "../components/ui/Textarea";
import { useWs } from "../hooks/useWs";
import type { Item } from "../lib/types";
import { formatBytes, sha256Hex } from "../lib/utils";

const maxFileSize = 5 * 1024 * 1024 * 1024; // 5GB

interface PendingFile {
  file: File;
  progress: number;
  status: "idle" | "uploading" | "done" | "error";
  error?: string;
}

function putWithProgress(
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    const token = getAccessToken();
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
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

interface DropBoardProps {
  isEphemeral?: boolean;
}

export function DropBoard({ isEphemeral = false }: DropBoardProps) {
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [list, setList] = useState<Item[]>([]);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomAnchorRef.current?.scrollIntoView({ behavior });
  }, []);

  const addFiles = useCallback((incomingList: FileList | File[]) => {
    const next = Array.from(incomingList)
      .filter((f) => f.size > 0)
      .map((f) => ({ file: f, progress: 0, status: "idle" as const }));
    if (!next.length) return;

    const oversized = next.filter((f) => f.file.size > maxFileSize);
    if (oversized.length) {
      setError(
        `文件超过大小上限（${formatBytes(maxFileSize)}）：${oversized.map((f) => f.file.name).join("、")}`,
      );
      return;
    }
    setFiles((prev) => [...prev, ...next]);
    setError(null);
  }, []);

  // Global window drag & drop listener
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        dragCounter.current += 1;
        if (dragCounter.current === 1) {
          setIsDraggingOver(true);
        }
      }
    };

    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) {
          setIsDraggingOver(false);
        }
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        dragCounter.current = 0;
        setIsDraggingOver(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          addFiles(e.dataTransfer.files);
        }
      }
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [addFiles]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    void api.items({ limit: 30, is_ephemeral: isEphemeral }).then((page) => {
      if (cancelled) return;
      // Server returns newest-first, reverse to display oldest-to-newest (top-to-bottom)
      setList([...page.items].reverse());
      cursorRef.current = page.next_cursor;
      setHasMore(!!page.next_cursor);
      setTimeout(() => {
        scrollToBottom("auto");
      }, 50);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadTick, scrollToBottom, isEphemeral]);

  // Load older messages (at top)
  const loadOlder = useCallback(async () => {
    if (!cursorRef.current || loadingMore) return;
    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight || 0;
    const previousScrollTop = container?.scrollTop || 0;

    setLoadingMore(true);
    try {
      const page = await api.items({ cursor: cursorRef.current, limit: 20, is_ephemeral: isEphemeral });
      const olderItems = [...page.items].reverse();
      setList((prev) => [...olderItems, ...prev]);
      cursorRef.current = page.next_cursor;
      setHasMore(!!page.next_cursor);

      // Maintain scroll position after prepending older items
      requestAnimationFrame(() => {
        if (container) {
          const heightDifference = container.scrollHeight - previousScrollHeight;
          container.scrollTop = previousScrollTop + heightDifference;
        }
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, isEphemeral]);

  // Real-time synchronization
  useWs({
    onEvent: (event) => {
      if (event.type === "item_created") {
        if (Boolean(event.item.is_ephemeral) === Boolean(isEphemeral)) {
          setList((prev) => [...prev.filter((i) => i.id !== event.item.id), event.item]);
          setTimeout(() => scrollToBottom("smooth"), 50);
        }
      } else if (event.type === "item_deleted") {
        setList((prev) => prev.filter((i) => i.id !== event.id));
      }
    },
  });

  const handleSend = async () => {
    if (submitting) return;
    const trimmedNote = note.trim();
    if (!trimmedNote && files.length === 0) return;

    setSubmitting(true);
    setError(null);

    try {
      if (files.length > 0) {
        setFiles((prev) => prev.map((f) => ({ ...f, status: "uploading", progress: 0 })));

        const specs = await Promise.all(
          files.map(async (f) => ({
            file_name: f.file.name,
            mime_type: f.file.type || "application/octet-stream",
            size: f.file.size,
            sha256: await sha256Hex(f.file),
          })),
        );

        const created = await api.createFileItem(specs, trimmedNote || null, isEphemeral);
        let allOk = true;

        const uploads = created.files.map(async (target, i) => {
          if (target.already_exists) {
            setFiles((prev) =>
              prev.map((p, idx) => (idx === i ? { ...p, status: "done", progress: 100 } : p)),
            );
            return;
          }
          try {
            await putWithProgress(target.upload_url, files[i].file, (pct) => {
              setFiles((prev) =>
                prev.map((p, idx) => (idx === i ? { ...p, progress: pct } : p)),
              );
            });
            setFiles((prev) =>
              prev.map((p, idx) => (idx === i ? { ...p, status: "done", progress: 100 } : p)),
            );
          } catch (e) {
            allOk = false;
            setFiles((prev) =>
              prev.map((p, idx) =>
                idx === i ? { ...p, status: "error", error: (e as Error).message } : p,
              ),
            );
          }
        });

        await Promise.all(uploads);

        if (!allOk) {
          setError("部分文件上传失败，未完成条目将在 1 小时后自动清理");
          return;
        }

        await api.uploadComplete(created.item_id);
        setFiles([]);
        setNote("");
        setReloadTick((t) => t + 1);
        setTimeout(() => scrollToBottom("smooth"), 100);
      } else if (trimmedNote) {
        await api.createNote(trimmedNote, isEphemeral);
        setNote("");
        setReloadTick((t) => t + 1);
        setTimeout(() => scrollToBottom("smooth"), 100);
      }
    } catch (e) {
      if (e instanceof Error) {
        setError(e.message || "发送失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-1 min-h-0 flex-col px-3 sm:px-4">
      {/* 全局拖拽全屏悬浮提示 */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-md p-6 text-center animate-in fade-in duration-150 pointer-events-none">
          <div className="flex flex-col items-center gap-4 rounded-2xl border-4 border-dashed border-primary/60 bg-card/80 p-8 sm:p-12 shadow-2xl">
            <div className="flex h-16 w-16 sm:h-20 sm:w-20 items-center justify-center rounded-full bg-primary/10">
              <FileUp className="h-8 w-8 sm:h-10 sm:w-10 text-primary animate-bounce" />
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-lg sm:text-xl font-bold tracking-tight">拖进浏览器并松手即可上传</p>
              <p className="text-xs sm:text-sm text-muted-foreground">文件将添加到输入框顶部，点击发送即可上传</p>
            </div>
          </div>
        </div>
      )}

      {/* 临时中转提示横幅 */}
      {isEphemeral && (
        <div className="mt-2 shrink-0 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          <span>临时中转：所有内容与文件仅保留 24 小时，到期自动物理销毁</span>
        </div>
      )}

      {/* 时间线消息流（可滚动区域，越往上越老） */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto py-3 space-y-3 pr-1"
      >
        {/* 加载更早内容按钮 */}
        {hasMore && (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={loadOlder}
              disabled={loadingMore}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {loadingMore ? "加载更早内容中…" : "↑ 加载更早内容"}
            </Button>
          </div>
        )}

        {/* 消息列表 / 空状态 */}
        {list.length === 0 ? (
          <div className="flex h-full min-h-[240px] items-center justify-center">
            <EmptyState
              icon={<Inbox className="h-10 w-10 text-muted-foreground" />}
              title={isEphemeral ? "中转站空空如也" : "还没有任何内容"}
              hint={
                isEphemeral
                  ? "在此发送的笔记或文件仅保留 24 小时，到期自动清理"
                  : "在此发送的笔记或文件将永久保存，其他设备可随时查看"
              }
            />
          </div>
        ) : (
          list.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onDeleted={(id) => setList((prev) => prev.filter((i) => i.id !== id))}
            />
          ))
        )}
        <div ref={bottomAnchorRef} />
      </div>

      {/* 底部输入与发送卡片（固定在底部） */}
      <div className="shrink-0 pt-2 pb-2 sm:pb-3">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-2.5 sm:p-3 shadow-sm">
          {/* 待上传文件列表（输入框顶部） */}
          {files.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                <span>待上传文件 ({files.length})</span>
                {!submitting && (
                  <button
                    type="button"
                    onClick={() => setFiles([])}
                    className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                  >
                    清空全部
                  </button>
                )}
              </div>
              <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto">
                {files.map((f, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2.5 rounded-md border bg-card px-2.5 py-1.5 text-sm shadow-sm"
                  >
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-xs sm:text-sm">{f.file.name}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">{formatBytes(f.file.size)}</span>
                        {f.status === "uploading" && (
                          <span className="text-[11px] tabular-nums text-primary font-medium">{f.progress}%</span>
                        )}
                        {f.status === "done" && <span className="text-[11px] text-green-600 font-medium">已就绪</span>}
                        {f.status === "error" && <span className="text-[11px] text-destructive">{f.error ?? "失败"}</span>}
                      </div>
                      {submitting && f.status === "uploading" && (
                        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                          <div className="h-full bg-primary transition-all duration-150" style={{ width: `${f.progress}%` }} />
                        </div>
                      )}
                    </div>
                    {!submitting && (
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        className="shrink-0 p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                        title="移除"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <Textarea
            placeholder="写一条笔记，或添加文件后发送…"
            value={note}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void handleSend();
              }
            }}
          />

          {error && <p className="text-xs text-destructive px-1">{error}</p>}

          <div className="flex items-center justify-between pt-0.5">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {files.length > 0 ? `已选 ${files.length} 个文件` : "Ctrl+Enter 快捷发送"}
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => fileInputRef.current?.click()}
                title="添加文件"
                className="gap-1 text-xs font-normal"
              >
                <Plus className="h-4 w-4" />
                <span>添加文件</span>
              </Button>
              <Button
                size="sm"
                disabled={submitting || (!note.trim() && files.length === 0)}
                onClick={handleSend}
                className="text-xs px-4"
              >
                {submitting && <Spinner className="mr-1" />}
                {submitting ? "上传中…" : "发送"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
