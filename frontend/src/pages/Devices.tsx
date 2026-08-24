import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Smartphone } from "lucide-react";

import { api } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/Misc";
import { formatDateTime } from "../lib/format";

export function Devices() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameDevice(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDevice(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });

  if (isLoading) return <EmptyState title="加载中…" />;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="mb-2 text-xl font-semibold">设备</h1>
      {devices.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-10 w-10 text-muted-foreground" />}
          title="还没有登记的设备"
        />
      ) : (
        devices.map((device) => (
          <Card key={device.id}>
            <CardContent className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                {editing === device.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                      value={name}
                      maxLength={255}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Button
                      size="sm"
                      disabled={!name.trim() || renameMutation.isPending}
                      onClick={() =>
                        renameMutation.mutate({ id: device.id, name: name.trim() })
                      }
                    >
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="truncate font-medium">{device.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      最后在线 {formatDateTime(device.last_seen_at)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      登记于 {formatDateTime(device.created_at)}
                    </p>
                  </>
                )}
              </div>
              {editing !== device.id && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(device.id);
                      setName(device.name);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    改名
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (confirm(`删除设备「${device.name}」？该设备的登录将立即失效。`)) {
                        deleteMutation.mutate(device.id);
                      }
                    }}
                  >
                    删除
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        删除设备后，该设备上的登录将立即失效。当前设备可在此改名。
      </p>
    </div>
  );
}
