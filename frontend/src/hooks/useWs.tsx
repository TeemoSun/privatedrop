import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { getAccessToken, refreshAccessToken } from "../lib/api";
import type { WsEvent } from "../lib/types";

interface WsContextType {
  connected: boolean;
  connecting: boolean;
  reconnect: () => void;
  subscribe: (listener: (event: WsEvent) => void) => () => void;
}

const WsContext = createContext<WsContextType | null>(null);

const MAX_RETRY_DELAY = 30_000;

export function WsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const listenersRef = useRef<Set<(event: WsEvent) => void>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1_000);
  const closedRef = useRef(false);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const token = getAccessToken();
    if (!token) {
      setConnected(false);
      setConnecting(false);
      return;
    }

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.onopen = null;
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    setConnecting(true);

    try {
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws?token=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setConnecting(false);
        retryDelayRef.current = 1_000;
      };

      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data as string) as WsEvent;
          listenersRef.current.forEach((listener) => {
            try {
              listener(event);
            } catch (err) {
              console.error("Ws event handler error:", err);
            }
          });
        } catch {
          /* 忽略无法解析的消息 */
        }
      };

      ws.onclose = async (ev) => {
        setConnected(false);
        setConnecting(false);
        if (closedRef.current) return;

        if (ev.code === 4401) {
          const fresh = await refreshAccessToken();
          if (!fresh) {
            closedRef.current = true;
            return;
          }
        }

        const delay = retryDelayRef.current;
        retryTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
        retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_DELAY);
      };

      ws.onerror = () => {
        setConnected(false);
        setConnecting(false);
        try {
          ws.close();
        } catch {}
      };
    } catch {
      setConnected(false);
      setConnecting(false);
    }
  }, []);

  const reconnect = useCallback(() => {
    retryDelayRef.current = 1_000;
    connect();
  }, [connect]);

  const subscribe = useCallback((listener: (event: WsEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
  }, [connect]);

  return (
    <WsContext.Provider value={{ connected, connecting, reconnect, subscribe }}>
      {children}
    </WsContext.Provider>
  );
}

export function useWsStatus() {
  const ctx = useContext(WsContext);
  if (!ctx) {
    return { connected: true, connecting: false, reconnect: () => {} };
  }
  return {
    connected: ctx.connected,
    connecting: ctx.connecting,
    reconnect: ctx.reconnect,
  };
}

interface UseWsOptions {
  onEvent: (event: WsEvent) => void;
  enabled?: boolean;
}

export function useWs({ onEvent, enabled = true }: UseWsOptions): void {
  const ctx = useContext(WsContext);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!ctx || !enabled) return;
    return ctx.subscribe((event) => {
      onEventRef.current(event);
    });
  }, [ctx, enabled]);
}
