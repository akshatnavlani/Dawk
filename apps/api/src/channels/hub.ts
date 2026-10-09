export type ChannelEvent = {
  id: string;
  body: string;
  authorKind: "user" | "agent" | "system";
  authorUserId: string | null;
  createdAt: string;
};

type Listener = (event: ChannelEvent) => void;

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

export function publishMessageCreated(
  channelId: string,
  event: ChannelEvent,
): void {
  const current = listeners.get(channelId);
  if (!current) {
    return;
  }
  for (const listener of current) {
    listener(event);
  }
}
