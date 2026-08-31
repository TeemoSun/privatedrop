import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Smartphone } from "lucide-react";

import { api, clearTokens, getDeviceId, setDeviceName } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { EmptyState } from "../components/ui/Misc";
import { formatDateTime } from "../lib/format";
import { cn } from "../lib/utils";

export function Devices() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const currentDeviceId = getDeviceId();

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameDevice(id, name),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      if (variables.id.toLowerCase() === currentDeviceId.toLowerCase()) {
        setDeviceName(variables.name);
      }
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDevice(id),
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      if (deletedId.toLowerCase() === currentDeviceId.toLowerCase()) {
        clearTokens();
        window.dispatchEvent(new Event("pd:unauthorized"));
      }
    },
  });

  if (isLoading) return <EmptyState title="加载中…" />;

  const sortedDevices = [...devices].sort((a, b) => {
    const aCurrent = a.id.toLowerCase() === currentDeviceId.toLowerCase();
    const bCurrent = b.id.toLowerCase() === currentDeviceId.toLowerCase();
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return (
    <div className="flex flex-col gap-3">
      <h1 className="mb-2 text-xl font-semibold">设备</h1>
      {sortedDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-10 w-10 text-muted-foreground" />}
          title="还没有登记的设备"
        />
      ) : (
        sortedDevices.map((device) => {
          const isCurrent = device.id.toLowerCase() === currentDeviceId.toLowerCase();
          return (
            <Card
              key={device.id}
              className={cn("transition-colors", isCurrent && "border-primary/50 shadow-sm")}
            >
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
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium">{device.name}</p>
                        {isCurrent && (
                          <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            当前设备
                          </span>
                        )}
                      </div>
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
                        const msg = isCurrent
                          ? "确定删除当前设备？删除后将立即退出登录。"
                          : `删除设备「${device.name}」？该设备的登录将立即失效。`;
                        if (confirm(msg)) {
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
          );
        })
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        删除设备后，该设备上的登录将立即失效。当前设备可在此改名。
      </p>
    </div>
  );
}
