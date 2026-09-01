import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { File as FileIcon, FileUp, Inbox, Lock, Plus, SendHorizontal, X } from "lucide-react";

import { api, getAccessToken } from "../lib/api";
import { isSecretUnlocked, lockSecretSession } from "../lib/secretSession";
import { getSendOnEnter } from "../lib/settings";
import { ItemCard } from "../components/ItemCard";
import { Button } from "../components/ui/Button";
import { EmptyState, Spinner } from "../components/ui/Misc";
import { useWs } from "../hooks/useWs";
import type { Item } from "../lib/types";
import { cn, formatBytes, sha256Hex } from "../lib/utils";

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
  isSecret?: boolean;
}

export function DropBoard({ isEphemeral = false, isSecret = false }: DropBoardProps) {
  const navigate = useNavigate();
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Guard against refresh or direct access to secret timeline
  useEffect(() => {
    if (isSecret && !isSecretUnlocked()) {
      navigate("/timeline", { replace: true });
    }
  }, [isSecret, navigate]);

  // Lock secret session upon unmounting/leaving
  useEffect(() => {
    return () => {
      if (isSecret) {
        lockSecretSession();
      }
    };
  }, [isSecret]);

  // 5-minute inactivity auto-lock for secret timeline
  useEffect(() => {
    if (!isSecret) return;

    let timer: number;

    const resetTimer = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lockSecretSession();
        navigate("/timeline", { replace: true });
      }, 5 * 60 * 1000); // 5 minutes
    };

    resetTimer();

    const activityEvents = ["mousedown", "mousemove", "keydown", "touchstart", "scroll", "click"];
    const onActivity = () => resetTimer();

    activityEvents.forEach((event) => {
      window.addEventListener(event, onActivity, { passive: true });
    });

    return () => {
      if (timer) window.clearTimeout(timer);
      activityEvents.forEach((event) => {
        window.removeEventListener(event, onActivity);
      });
    };
  }, [isSecret, navigate]);

  const [list, setList] = useState<Item[]>([]);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [note]);

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
    void api.items({ limit: 30, is_ephemeral: isEphemeral, is_secret: isSecret }).then((page) => {
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
  }, [reloadTick, scrollToBottom, isEphemeral, isSecret]);

  // Load older messages (at top)
  const loadOlder = useCallback(async () => {
    if (!cursorRef.current || loadingMore) return;
    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight || 0;
    const previousScrollTop = container?.scrollTop || 0;

    setLoadingMore(true);
    try {
      const page = await api.items({
        cursor: cursorRef.current,
        limit: 20,
        is_ephemeral: isEphemeral,
        is_secret: isSecret,
      });
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
  }, [loadingMore, isEphemeral, isSecret]);

  // Real-time synchronization
  useWs({
    onEvent: (event) => {
      if (event.type === "item_created") {
        if (
          Boolean(event.item.is_ephemeral) === Boolean(isEphemeral) &&
          Boolean(event.item.is_secret) === Boolean(isSecret)
        ) {
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

        const created = await api.createFileItem(specs, trimmedNote || null, isEphemeral, isSecret);
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
        await api.createNote(trimmedNote, isEphemeral, isSecret);
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

      {/* 隐私时间线提示 */}
      {isSecret && (
        <div className="mt-2 shrink-0 flex items-center justify-between rounded-md bg-muted/60 border px-3 py-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-primary" />
            <span className="font-medium text-foreground">隐私时间线</span>
            <span>· 仅长按入口可访问，私密保存</span>
          </div>
        </div>
      )}

      {/* 时间线消息流（可滚动区域，越往上越老） */}
      <div
        ref={scrollContainerRef}
        className="flex-1 min-h-0 overflow-y-auto py-4 space-y-6 pr-1"
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
              icon={
                isSecret ? (
                  <Lock className="h-10 w-10 text-muted-foreground" />
                ) : (
                  <Inbox className="h-10 w-10 text-muted-foreground" />
                )
              }
              title={
                isSecret
                  ? "隐私时间线暂无内容"
                  : isEphemeral
                    ? "中转站空空如也"
                    : "还没有任何内容"
              }
              hint={
                isSecret
                  ? "在此发送的笔记或文件仅在此隐私空间展示，在外部不可见"
                  : isEphemeral
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
      <div className="shrink-0 pt-1 pb-2 sm:pb-3">
        {/* 待上传文件列表（输入框顶部） */}
        {files.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5 rounded-xl border bg-card p-2 shadow-xs">
            <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>待上传文件 ({files.length})</span>
              {!submitting && (
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
                >
                  清空全部
                </button>
              )}
            </div>
            <div className="flex max-h-36 flex-col gap-1.5 overflow-y-auto">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-sm"
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
                      className="shrink-0 p-1 text-muted-foreground hover:text-foreground rounded transition-colors cursor-pointer"
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

        {error && <p className="mb-1.5 px-2 text-xs text-destructive">{error}</p>}

        {/* 紧凑型输入条 */}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {/* 窄型胶囊输入框（内嵌发送箭头） */}
          <div className="relative flex min-h-[42px] flex-1 items-end rounded-2xl border border-input bg-card shadow-xs transition-colors focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20">
            <textarea
              ref={textareaRef}
              rows={1}
              value={note}
              placeholder={
                getSendOnEnter()
                  ? "写一条笔记，或添加文件后发送… (Enter 发送)"
                  : "写一条笔记，或添加文件后发送…"
              }
              onChange={(e) => setNote(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (getSendOnEnter() && e.key === "Enter" && !e.shiftKey) {
                  if (e.nativeEvent.isComposing) {
                    return;
                  }
                  e.preventDefault();
                  void handleSend();
                }
              }}
              className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent py-2.5 pl-3.5 pr-2 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={submitting || (!note.trim() && files.length === 0)}
              className={cn(
                "my-1.5 mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all cursor-pointer",
                note.trim() || files.length > 0
                  ? "text-blue-600 hover:text-blue-700 active:scale-95 dark:text-blue-400"
                  : "text-muted-foreground/30 cursor-not-allowed",
              )}
              title="发送"
            >
              {submitting ? (
                <Spinner className="h-4 w-4 text-blue-600" />
              ) : (
                <SendHorizontal className="h-5 w-5" />
              )}
            </button>
          </div>

          {/* 右侧圆形添加文件按钮 (+) */}
          <button
            type="button"
            disabled={submitting}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-xs transition-all hover:bg-blue-700 active:scale-95 disabled:opacity-50 cursor-pointer"
            title="添加文件"
          >
            <Plus className="h-5 w-5 stroke-[2.5]" />
          </button>
        </div>
      </div>
    </div>
  );
}
