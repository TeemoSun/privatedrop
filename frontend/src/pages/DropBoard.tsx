import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";

import { api } from "../lib/api";
import { DropZone } from "../components/DropZone";
import { ItemCard } from "../components/ItemCard";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/Misc";
import { Textarea } from "../components/ui/Textarea";
import { useWs } from "../hooks/useWs";
import type { Item } from "../lib/types";

export function DropBoard() {
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [list, setList] = useState<Item[]>([]);
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const loadPage = useCallback(async (cursor: string | null) => {
    const page = await api.items({ cursor: cursor ?? undefined, limit: 20 });
    return page;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadPage(null).then((page) => {
      if (cancelled) return;
      setList(page.items);
      cursorRef.current = page.next_cursor;
      setHasMore(!!page.next_cursor);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPage, reloadTick]);

  const loadMore = useCallback(async () => {
    if (!cursorRef.current) return;
    setLoadingMore(true);
    try {
      const page = await loadPage(cursorRef.current);
      setList((prev) => [...prev, ...page.items]);
      cursorRef.current = page.next_cursor;
      setHasMore(!!page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }, [loadPage]);

  useWs({
    onEvent: (event) => {
      if (event.type === "item_created") {
        setList((prev) => [event.item, ...prev.filter((i) => i.id !== event.item.id)]);
      } else if (event.type === "item_deleted") {
        setList((prev) => prev.filter((i) => i.id !== event.id));
      }
    },
  });

  const saveNote = async () => {
    if (!note.trim() || savingNote) return;
    setSavingNote(true);
    try {
      await api.createNote(note.trim());
      setNote("");
      setReloadTick((t) => t + 1);
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <DropZone onCreated={() => setReloadTick((t) => t + 1)} />

      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <Textarea
          placeholder="写一条笔记…"
          value={note}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void saveNote();
            }
          }}
        />
        <div className="flex justify-end">
          <Button size="sm" disabled={!note.trim() || savingNote} onClick={saveNote}>
            {savingNote ? "保存中…" : "发布笔记"}
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-10 w-10 text-muted-foreground" />}
          title="还没有任何内容"
          hint="拖入文件或写一条笔记，其他设备会实时看到"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {list.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onDeleted={(id) => setList((prev) => prev.filter((i) => i.id !== id))}
            />
          ))}
          {hasMore && (
            <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "加载中…" : "加载更多"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
