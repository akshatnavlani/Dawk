"use client";

import { useEffect, useRef, useState } from "react";
import {
  API_ORIGIN,
  buttonClass,
  fieldClass,
  messageFor,
} from "../../auth-shared";
import { DecisionsPanel } from "./decisions-panel";

type ChatMessage = {
  id: string;
  body: string;
  authorKind: "user" | "agent" | "system";
  createdAt: string;
};

type Channel = {
  id: string;
  agentId: string;
  name: string;
  kind: string;
  status: string;
};

type RunStep = {
  stepIndex: number;
  iteration: number;
  notes: string | null;
  model: string | null;
  tokenIn: number | null;
  tokenOut: number | null;
};

type PlanView = {
  id: string;
  agentId: string;
  status: string;
  body: {
    summary: string;
    steps: string[];
  };
};

type RunView = {
  id: string;
  status: string;
  failureReason: string | null;
  steps: RunStep[];
};

type QueueItem = {
  id: string;
  messageId: string;
  body: string;
  createdAt: string;
};

type ConflictOption = {
  label?: string;
  body?: string;
  role?: string;
  messageId?: string;
  selected?: boolean;
};

type ConflictView = {
  id: string;
  status: string;
  options: ConflictOption[];
};

type SpendView = {
  spendUsed: number;
  spendCap: number | null;
  llmPaused: boolean;
};

const failureText: Record<string, string> = {
  spend_paused: "LLM calls are paused for this project.",
  spend_cap: "This project is at its spend cap.",
  missing_credential: "The owner has not saved a provider key.",
  provider_failed: "The provider call failed.",
  iteration_limit: "The Orchestrator stopped at the iteration limit.",
  missing_skill: "This agent has no skill pack.",
  invalid_response: "The model reply could not be read.",
  agent_busy: "The Orchestrator is already working.",
  awaiting_approval: "A plan is waiting for the owner.",
  rate_limited: "Too many runs were started. Try again later.",
  queued: "That request is queued until the Orchestrator is free.",
  queue_full: "The queue is full. Try again later.",
  intent_required: "Say whether this is work to queue or a question.",
  qa_busy: "A question is already being answered.",
  conflict_open: "An open conflict has to be resolved first.",
};

function mergeMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const message of incoming) {
    if (!seen.has(message.id)) {
      seen.add(message.id);
      next.push(message);
    }
  }
  return next;
}

export function ChannelThread({
  projectId,
  role,
}: {
  projectId: string;
  role: "owner" | "member";
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [run, setRun] = useState<RunView | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [spend, setSpend] = useState<SpendView | null>(null);
  const [intentMessageId, setIntentMessageId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

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
    let cancelled = false;
    setRun(null);
    setPlan(null);
    async function loadHistory() {
      const response = await fetch(
        `${API_ORIGIN}/channels/${channelId}/messages`,
        { credentials: "include" },
      );
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as {
        messages?: ChatMessage[];
        nextCursor?: string | null;
      };
      setMessages(body.messages ?? []);
      setNextCursor(body.nextCursor ?? null);
    }
    async function loadRun() {
      const response = await fetch(
        `${API_ORIGIN}/channels/${channelId}/runs/latest`,
        { credentials: "include" },
      );
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as { run?: RunView | null };
      setRun(body.run ?? null);
    }

    async function loadPlan() {
      const channel = channelsRef.current.find((item) => item.id === channelId);
      if (!channel) {
        return;
      }
      const response = await fetch(
        `${API_ORIGIN}/agents/${channel.agentId}/plans/latest`,
        { credentials: "include" },
      );
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as { plan?: PlanView | null };
      setPlan(body.plan ?? null);
    }
    async function loadQueue() {
      const response = await fetch(
        `${API_ORIGIN}/channels/${channelId}/queue`,
        {
          credentials: "include",
        },
      );
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as { items?: QueueItem[] };
      setQueue(body.items ?? []);
    }
    async function loadConflict() {
      const response = await fetch(
        `${API_ORIGIN}/channels/${channelId}/conflicts/open`,
        { credentials: "include" },
      );
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as {
        conflict?: ConflictView | null;
      };
      setConflict(body.conflict ?? null);
    }

    void loadHistory();
    void loadRun();
    void loadPlan();
    void loadQueue();
    void loadConflict();

    const source = new EventSource(
      `${API_ORIGIN}/channels/${channelId}/events`,
      { withCredentials: true },
    );
    let opened = false;
    source.addEventListener("message.created", (event) => {
      const message = JSON.parse(event.data) as ChatMessage;
      setMessages((current) => mergeMessages(current, [message]));
    });
    for (const name of [
      "run.started",
      "run.step",
      "run.completed",
      "run.failed",
    ]) {
      source.addEventListener(name, () => {
        void loadRun();
      });
    }
    source.addEventListener("plan.updated", () => {
      void loadPlan();
    });
    source.addEventListener("conflict.opened", () => {
      void loadConflict();
    });
    source.addEventListener("conflict.resolved", () => {
      void loadConflict();
      void loadQueue();
    });
    source.addEventListener("spend.updated", (event) => {
      const body = JSON.parse(event.data) as SpendView;
      setSpend(body);
      void loadQueue();
    });
    source.onopen = () => {
      if (opened) {
        void loadHistory();
        void loadRun();
        void loadPlan();
        void loadQueue();
        void loadConflict();
      }
      opened = true;
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, [channelId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch(`${API_ORIGIN}/projects/${projectId}`, {
        credentials: "include",
      });
      if (!response.ok || cancelled) {
        return;
      }
      const body = (await response.json()) as SpendView;
      setSpend({
        spendUsed: body.spendUsed,
        spendCap: body.spendCap,
        llmPaused: body.llmPaused,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }
    setChannels((current) => {
      let changed = false;
      const next = current.map((channel) => {
        if (channel.id !== channelId) {
          return channel;
        }
        const status =
          run?.status === "pending" || run?.status === "running"
            ? "working"
            : plan?.status === "awaiting"
              ? "awaiting_approval"
              : run || plan
                ? "idle"
                : channel.status;
        if (status === channel.status) {
          return channel;
        }
        changed = true;
        return { ...channel, status };
      });
      return changed ? next : current;
    });
  }, [channelId, plan, run]);

  useEffect(() => {
    const others = channels.filter((channel) => channel.id !== channelId);
    const sources = others.map((channel) => {
      const source = new EventSource(
        `${API_ORIGIN}/channels/${channel.id}/events`,
        { withCredentials: true },
      );
      source.addEventListener("message.created", () => {
        setUnread((current) => ({
          ...current,
          [channel.id]: (current[channel.id] ?? 0) + 1,
        }));
      });
      return source;
    });
    return () => {
      for (const source of sources) {
        source.close();
      }
    };
  }, [channels, channelId]);

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
    setNotice(null);
    setIntentMessageId(null);
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
    const message = (await response.json()) as ChatMessage & {
      run?: { error?: string };
    };
    setMessages((current) =>
      current.some((item) => item.id === message.id)
        ? current
        : [...current, message],
    );
    const code = message.run?.error;
    if (code === "queued") {
      setNotice(failureText.queued ?? null);
    } else if (code === "intent_required") {
      setIntentMessageId(message.id);
      setNotice(failureText.intent_required ?? null);
    } else if (code && failureText[code]) {
      setError(failureText[code] ?? "The run did not start.");
    }
    const queueResponse = await fetch(
      `${API_ORIGIN}/channels/${channelId}/queue`,
      { credentials: "include" },
    );
    if (queueResponse.ok) {
      const queued = (await queueResponse.json()) as { items?: QueueItem[] };
      setQueue(queued.items ?? []);
    }
    const latest = await fetch(
      `${API_ORIGIN}/channels/${channelId}/runs/latest`,
      { credentials: "include" },
    );
    if (latest.ok) {
      const body = (await latest.json()) as { run?: RunView | null };
      setRun(body.run ?? null);
    }
    setDraft("");
  }

  async function decide(action: "approve" | "reject") {
    if (!plan) {
      return;
    }
    setError(null);
    const response = await fetch(`${API_ORIGIN}/plans/${plan.id}/${action}`, {
      method: "POST",
      credentials: "include",
    });
    const body = (await response.json()) as {
      error?: string;
      plan?: PlanView;
    };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    setPlan(body.plan ?? null);
  }

  async function chooseIntent(intent: "work" | "question") {
    if (!channelId || !intentMessageId) {
      return;
    }
    setError(null);
    setNotice(null);
    const response = await fetch(
      `${API_ORIGIN}/channels/${channelId}/messages/${intentMessageId}/intent`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent }),
      },
    );
    const body = (await response.json()) as { run?: { error?: string } };
    if (!response.ok) {
      setError(messageFor("invalid_request"));
      return;
    }
    const code = body.run?.error;
    if (code === "queued") {
      setNotice(failureText.queued ?? null);
      setIntentMessageId(null);
    } else if (code && failureText[code]) {
      setError(failureText[code] ?? null);
    } else {
      setIntentMessageId(null);
    }
    const queueResponse = await fetch(
      `${API_ORIGIN}/channels/${channelId}/queue`,
      { credentials: "include" },
    );
    if (queueResponse.ok) {
      const queued = (await queueResponse.json()) as { items?: QueueItem[] };
      setQueue(queued.items ?? []);
    }
  }

  async function chooseConflict(optionIndex: number) {
    if (!conflict) {
      return;
    }
    setError(null);
    const response = await fetch(
      `${API_ORIGIN}/conflicts/${conflict.id}/resolve`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ optionIndex }),
      },
    );
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(messageFor(body.error ?? null));
      return;
    }
    setConflict(null);
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
            onClick={() => {
              setChannelId(channel.id);
              setUnread((current) => ({ ...current, [channel.id]: 0 }));
            }}
          >
            {channel.name}
            <span className="ml-2 text-xs opacity-70">{channel.status}</span>
            {unread[channel.id] ? (
              <span className="ml-2 rounded-full bg-emerald-200 px-2 text-xs text-emerald-950">
                {unread[channel.id]}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="mt-4 rounded-lg border border-stone-200 bg-white px-4 py-3">
        <p className="text-sm text-stone-500">
          {selected ? `${selected.name} · ${selected.kind}` : "No channel yet."}
        </p>
        {spend?.llmPaused ? (
          <p className="mt-3 text-sm text-red-700">
            LLM calls are paused for this project.
          </p>
        ) : null}
        {spend &&
        !spend.llmPaused &&
        spend.spendCap !== null &&
        spend.spendUsed >= spend.spendCap ? (
          <p className="mt-3 text-sm text-red-700">
            This project is at its spend cap.
          </p>
        ) : null}
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
        {plan ? (
          <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3">
            <h3 className="text-sm font-semibold">Plan · {plan.status}</h3>
            <p className="mt-2 whitespace-pre-wrap text-sm text-stone-800">
              {plan.body.summary}
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-800">
              {plan.body.steps.map((step) => (
                <li key={`${plan.id}-${step}`}>{step}</li>
              ))}
            </ol>
            {plan.status === "awaiting" && role === "owner" ? (
              <div className="mt-3 flex gap-2">
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void decide("approve")}
                >
                  Approve
                </button>
                <button
                  className={buttonClass}
                  type="button"
                  onClick={() => void decide("reject")}
                >
                  Reject
                </button>
              </div>
            ) : null}
            {plan.status === "awaiting" && role === "member" ? (
              <p className="mt-3 text-sm text-stone-600">
                Only the owner can approve this plan.
              </p>
            ) : null}
          </div>
        ) : null}
        {conflict ? (
          <div className="mt-4 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3">
            <h3 className="text-sm font-semibold">Conflict</h3>
            <ul className="mt-2 space-y-2">
              {conflict.options.map((option, index) => (
                <li
                  key={
                    option.messageId ??
                    `${option.role ?? "member"}-${option.label ?? option.body ?? "option"}`
                  }
                >
                  <p className="text-sm text-stone-800">
                    {option.role === "owner" ? "Owner" : "Member"}:{" "}
                    {option.body ?? option.label}
                  </p>
                  {role === "owner" ? (
                    <button
                      className={`${buttonClass} mt-2`}
                      type="button"
                      onClick={() => void chooseConflict(index)}
                    >
                      Choose this
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {role === "member" ? (
              <p className="mt-3 text-sm text-stone-600">
                Only the owner can resolve this conflict.
              </p>
            ) : null}
          </div>
        ) : null}
        {run && (run.steps.some((step) => step.notes) || run.failureReason) ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-amber-950">Working</h3>
            {run.failureReason ? (
              <p className="mt-2 text-sm text-red-700">
                {failureText[run.failureReason] ?? "The run failed."}
              </p>
            ) : null}
            <ul className="mt-2 space-y-2">
              {run.steps
                .filter((step) => step.notes)
                .map((step) => (
                  <li key={step.stepIndex}>
                    <p className="whitespace-pre-wrap text-sm text-stone-800">
                      {step.notes}
                    </p>
                    <p className="text-xs text-stone-500">
                      Step {step.iteration}
                      {step.model ? ` · ${step.model}` : ""}
                      {step.tokenIn !== null ? ` · ${step.tokenIn} in` : ""}
                      {step.tokenOut !== null ? ` · ${step.tokenOut} out` : ""}
                    </p>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
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
          {notice ? <p className="text-sm text-stone-600">{notice}</p> : null}
          {intentMessageId ? (
            <div className="flex gap-2">
              <button
                className={buttonClass}
                type="button"
                onClick={() => void chooseIntent("work")}
              >
                Queue as work
              </button>
              <button
                className={buttonClass}
                type="button"
                onClick={() => void chooseIntent("question")}
              >
                Ask as a question
              </button>
            </div>
          ) : null}
          {queue.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold">Queued</h3>
              <ul className="mt-2 space-y-1">
                {queue.map((item) => (
                  <li key={item.id} className="text-sm text-stone-700">
                    {item.body}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button className={buttonClass} type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </button>
        </form>
      </div>
      {channelId ? (
        <DecisionsPanel
          projectId={projectId}
          channelId={channelId}
          role={role}
        />
      ) : null}
    </section>
  );
}
