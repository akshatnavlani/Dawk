"use client";

import { useEffect, useState } from "react";
import { API_ORIGIN, buttonClass, fieldClass } from "../../auth-shared";

type ChatMessage = {
  id: string;
  body: string;
  authorKind: "user" | "agent" | "system";
  createdAt: string;
};

type Channel = {
  id: string;
  name: string;
  kind: string;
  status: string;
};

export function ChannelThread({ projectId }: { projectId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch(
        `${API_ORIGIN}/projects/${projectId}/channels`,
        {
          credentials: "include",
        },
      );
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { channels?: Channel[] };
      const list = body.channels ?? [];
      setChannels(list);
      setChannelId((current) => current ?? list[0]?.id ?? null);
    })();
  }, [projectId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }
    void (async () => {
      const response = await fetch(
        `${API_ORIGIN}/channels/${channelId}/messages`,
        { credentials: "include" },
      );
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as {
        messages?: ChatMessage[];
        nextCursor?: string | null;
      };
      setMessages(body.messages ?? []);
      setNextCursor(body.nextCursor ?? null);
    })();
  }, [channelId]);

  async function loadOlder() {
    if (!channelId || !nextCursor) {
      return;
    }
    const response = await fetch(
      `${API_ORIGIN}/channels/${channelId}/messages?cursor=${encodeURIComponent(nextCursor)}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as {
      messages?: ChatMessage[];
      nextCursor?: string | null;
    };
    setMessages((current) => [...(body.messages ?? []), ...current]);
    setNextCursor(body.nextCursor ?? null);
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!channelId) {
      return;
    }
    setPending(true);
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/channels/${channelId}/messages`,
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ body: draft }),
      },
    );
    setPending(false);
    if (!response.ok) {
      setError("The message was not saved.");
      return;
    }
    const message = (await response.json()) as ChatMessage;
    setMessages((current) =>
      current.some((item) => item.id === message.id)
        ? current
        : [...current, message],
    );
    setDraft("");
  }

  const selected = channels.find((channel) => channel.id === channelId);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Channels</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {channels.map((channel) => (
          <button
            key={channel.id}
            className={`rounded-full px-3 py-1 text-sm ${
              channel.id === channelId
                ? "bg-stone-900 text-white"
                : "bg-stone-200 text-stone-800"
            }`}
            type="button"
            onClick={() => setChannelId(channel.id)}
          >
            {channel.name}
            <span className="ml-2 text-xs opacity-70">{channel.status}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-stone-200 bg-white px-4 py-3">
        <p className="text-sm text-stone-500">
          {selected ? `${selected.name} · ${selected.kind}` : "No channel yet."}
        </p>
        {nextCursor ? (
          <button
            className="mt-3 text-sm font-medium text-stone-700 underline"
            type="button"
            onClick={() => void loadOlder()}
          >
            Load older
          </button>
        ) : null}
        <ul className="mt-3 space-y-3">
          {messages.length === 0 ? (
            <li className="text-sm text-stone-500">No messages yet.</li>
          ) : (
            messages.map((message) => (
              <li key={message.id}>
                <p className="text-xs text-stone-500">{message.authorKind}</p>
                <p className="whitespace-pre-wrap text-stone-900">
                  {message.body}
                </p>
              </li>
            ))
          )}
        </ul>
        <form className="mt-4 space-y-3" onSubmit={send}>
          <label className="block text-sm font-medium text-stone-700">
            Message
            <textarea
              className={fieldClass}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              required
            />
          </label>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          <button className={buttonClass} type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </button>
        </form>
      </div>
    </section>
  );
}
