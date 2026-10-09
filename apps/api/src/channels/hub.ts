export type ChannelEvent = {
  id: string;
  body: string;
  authorKind: "user" | "agent" | "system";
  authorUserId: string | null;
  createdAt: string;
};

export type HubEvent = {
  event: string;
  data: unknown;
};

type Listener = (event: HubEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(channelId: string, listener: Listener): () => void {
  const current = listeners.get(channelId) ?? new Set<Listener>();
  current.add(listener);
  listeners.set(channelId, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(channelId);
    }
  };
}

export function publish(channelId: string, event: string, data: unknown): void {
  const current = listeners.get(channelId);
  if (!current) {
    return;
  }
  for (const listener of current) {
    listener({ event, data });
  }
}

export function publishMessageCreated(
  channelId: string,
  event: ChannelEvent,
): void {
  publish(channelId, "message.created", event);
}
