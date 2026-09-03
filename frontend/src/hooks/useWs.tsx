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
const PING_INTERVAL = 1_000; // 每 1 秒发送一次心跳
const PONG_TIMEOUT = 5_000; // 5 秒内未收到任何响应则判定断开

export function WsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(() => !!getAccessToken());
  const listenersRef = useRef<Set<(event: WsEvent) => void>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1_000);
  const closedRef = useRef(false);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastReceivedAtRef = useRef<number>(Date.now());

  const stopHeartbeat = useCallback(() => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    lastReceivedAtRef.current = Date.now();
    pingTimerRef.current = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const now = Date.now();
        if (now - lastReceivedAtRef.current >= PONG_TIMEOUT) {
          // 超过 5 秒未收到任何服务端响应，判定断开
          stopHeartbeat();
          setConnected(false);
          setConnecting(false);
          try {
            wsRef.current?.close();
          } catch {}
          return;
        }

        try {
          wsRef.current.send("ping");
        } catch {
          stopHeartbeat();
          setConnected(false);
          setConnecting(false);
          try {
            wsRef.current?.close();
          } catch {}
        }
      }
    }, PING_INTERVAL);
  }, [stopHeartbeat]);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const token = getAccessToken();
    if (!token) {
      stopHeartbeat();
      setConnected(false);
      setConnecting(false);
      return;
    }

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    stopHeartbeat();

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
        startHeartbeat();
      };

      ws.onmessage = (msg) => {
        lastReceivedAtRef.current = Date.now();
        if (msg.data === "pong") {
          return;
        }

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
        stopHeartbeat();
        setConnected(false);
        if (closedRef.current) {
          setConnecting(false);
          return;
        }

        if (ev.code === 4401) {
          setConnecting(true);
          const fresh = await refreshAccessToken();
          if (closedRef.current) return;
          if (!fresh) {
            closedRef.current = true;
            setConnecting(false);
            return;
          }
          retryDelayRef.current = 1_000;
          connect();
          return;
        }

        setConnecting(false);
        const jitter = Math.floor(Math.random() * 500);
        const delay = Math.min(retryDelayRef.current + jitter, MAX_RETRY_DELAY);
        retryTimerRef.current = setTimeout(() => {
          connect();
        }, delay);
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, MAX_RETRY_DELAY);
      };

      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    } catch {
      stopHeartbeat();
      setConnected(false);
      setConnecting(false);
    }
  }, [startHeartbeat, stopHeartbeat]);

  const reconnect = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
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
      stopHeartbeat();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
  }, [connect, stopHeartbeat]);

  useEffect(() => {
    const handleOnline = () => {
      if (!connected && !connecting) {
        reconnect();
      }
    };
    const handleOffline = () => {
      stopHeartbeat();
      setConnected(false);
      setConnecting(false);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        if (!connected && !connecting) {
          reconnect();
        } else if (connected && wsRef.current?.readyState === WebSocket.OPEN) {
          if (Date.now() - lastReceivedAtRef.current >= PONG_TIMEOUT) {
            stopHeartbeat();
            setConnected(false);
            setConnecting(false);
            try {
              wsRef.current?.close();
            } catch {}
            reconnect();
          } else {
            try {
              wsRef.current.send("ping");
            } catch {}
          }
        }
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connected, connecting, reconnect, stopHeartbeat]);

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
