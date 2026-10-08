import { backoffDelay } from "./backoff";

export type SocketStatus = "connecting" | "open" | "reconnecting";

export interface ReconnectingSocket {
  close(): void;
  /** Skip the backoff wait and dial now (tab refocused, network back). */
  reconnectNow(): void;
}

/**
 * One long-lived WebSocket with automatic reconnect + backoff.
 *
 * The server broadcasts every message to every client (there is no
 * subscribe protocol), so the app keeps a single socket for its lifetime and
 * filters by the currently-open run on the client side. After a drop the
 * socket redials with exponential backoff; `onOpen({ reconnect: true })` tells
 * the app to resync whatever it was showing, since messages were missed.
 */
export function createSocket(opts: {
  onMessage: (msg: Record<string, unknown>) => void;
  onStatus: (s: SocketStatus) => void;
  onOpen: (info: { reconnect: boolean }) => void;
  /** Handshake failed before opening — probe an authed endpoint so a 401 redirects to /login. */
  onHandshakeFailure?: () => void;
}): ReconnectingSocket {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let everOpened = false;
  let closed = false;

  const url = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

  const connect = () => {
    if (closed) return;
    timer = null;
    opts.onStatus(everOpened || attempts > 0 ? "reconnecting" : "connecting");
    let opened = false;
    let sock: WebSocket;
    try {
      sock = new WebSocket(url());
    } catch {
      scheduleRetry();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      opened = true;
      attempts = 0;
      const reconnect = everOpened;
      everOpened = true;
      opts.onStatus("open");
      opts.onOpen({ reconnect });
    };
    sock.onmessage = (m) => {
      if (ws !== sock) return;
      try {
        opts.onMessage(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (closed) return;
      // Never opened (upgrade rejected, e.g. 401) or closed with a policy /
      // auth code: let the app check whether the session is still valid.
      if (!opened || ev.code === 1008 || ev.code === 4401) opts.onHandshakeFailure?.();
      opts.onStatus("reconnecting");
      scheduleRetry();
    };
    sock.onerror = () => {
      /* onclose follows; nothing extra to do */
    };
  };

  const scheduleRetry = () => {
    if (closed || timer) return;
    timer = setTimeout(connect, backoffDelay(attempts++));
  };

  const reconnectNow = () => {
    if (closed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (timer) clearTimeout(timer);
    timer = null;
    attempts = 0;
    connect();
  };

  // Phones freeze background tabs and drop their sockets; come back fast.
  const onVisible = () => {
    if (document.visibilityState === "visible") reconnectNow();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", reconnectNow);

  connect();

  return {
    reconnectNow,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconnectNow);
      const s = ws;
      ws = null;
      if (s) {
        s.onclose = s.onmessage = s.onopen = s.onerror = null;
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
