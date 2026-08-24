import { useEffect, useRef } from "react";

import { getAccessToken } from "../lib/api";
import type { WsEvent } from "../lib/types";

interface UseWsOptions {
  onEvent: (event: WsEvent) => void;
  enabled?: boolean;
}

const MAX_RETRY_DELAY = 30_000;
const MAX_RETRY_MS = MAX_RETRY_DELAY;

export function useWs({ onEvent, enabled = true }: UseWsOptions): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabledRef.current) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retryDelay = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const token = getAccessToken();
      if (!token) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        retryDelay = 1_000;
      };

      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data as string) as WsEvent;
          onEventRef.current(event);
        } catch {
          /* 忽略无法解析的消息 */
        }
      };

      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
