// Raw HTTP model gateway — no vendor SDK. Both providers serve an
// OpenAI-format /chat/completions endpoint, so one client covers both.

export type ModelKey =
  | "glm"
  | "glm-flash"
  | "muse"
  | "omni"
  | "deepseek"
  | "gpt-oss"
  | "kimi"
  | "mistral-nemotron"
  | "nemotron-super"
  | "nemotron-lightning"
  | "nemotron-ultra"
  | "gemma"
  | "deepseek-v4"
  | "llama-vision";

type ModelConfig = {
  id: string;
  label: string;
  note: string;
  provider: "nvidia" | "deepseek";
  temperature: number;
  top_p: number;
  max_tokens: number;
  extra?: Record<string, unknown>;
  /** False for a model that's only ever used internally (vision description), never offered as a build model. */
  buildable?: boolean;
};

export const MODELS: Record<ModelKey, ModelConfig> = {
  glm: { id: "z-ai/glm-5.3", label: "GLM 5.3", note: "Best quality", provider: "nvidia", temperature: 0.6, top_p: 1, max_tokens: 16384 },
  "glm-flash": { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash", note: "Faster, lighter", provider: "nvidia", temperature: 0.6, top_p: 1, max_tokens: 16384 },
  deepseek: { id: "deepseek-chat", label: "DeepSeek V3", note: "DeepSeek API", provider: "deepseek", temperature: 0.6, top_p: 1, max_tokens: 8192 },
  "gpt-oss": { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", note: "Open-weight, agentic", provider: "nvidia", temperature: 0.7, top_p: 1, max_tokens: 16384 },
  kimi: { id: "moonshotai/kimi-k3", label: "Kimi K3", note: "Long context", provider: "nvidia", temperature: 0.6, top_p: 0.95, max_tokens: 16384 },
  "mistral-nemotron": { id: "mistralai/mistral-nemotron", label: "Mistral Nemotron", note: "Agentic workflows", provider: "nvidia", temperature: 0.6, top_p: 1, max_tokens: 16384 },
  "nemotron-super": { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super", note: "Large MoE, high quality", provider: "nvidia", temperature: 0.6, top_p: 0.95, max_tokens: 16384 },
  "nemotron-lightning": { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning", note: "Fast MoE", provider: "nvidia", temperature: 0.6, top_p: 0.95, max_tokens: 16384 },
  "nemotron-ultra": { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", note: "Largest MoE, top quality", provider: "nvidia", temperature: 0.6, top_p: 0.95, max_tokens: 16384 },
  gemma: { id: "google/gemma-4-31b-it", label: "Gemma 4", note: "Google, 256K context", provider: "nvidia", temperature: 0.7, top_p: 0.95, max_tokens: 16384 },
  "deepseek-v4": { id: "deepseek-ai/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", note: "Via NVIDIA, 1M context", provider: "nvidia", temperature: 0.6, top_p: 1, max_tokens: 16384 },
  omni: {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    label: "Nemotron Omni",
    note: "Reasoning · sees images",
    provider: "nvidia",
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: 32768,
    extra: { reasoning_budget: 8192 },
    buildable: false,
  },
  muse: { id: "meta/muse-glimmer-30b", label: "Muse Glimmer", note: "Sees images", provider: "nvidia", temperature: 0.9, top_p: 0.95, max_tokens: 8192, buildable: false },
  "llama-vision": { id: "meta/llama-3.2-11b-vision-instruct", label: "Llama 3.2 Vision", note: "Sees images", provider: "nvidia", temperature: 0.6, top_p: 0.95, max_tokens: 4096, buildable: false },
};

export const MODEL_KEYS = Object.keys(MODELS) as ModelKey[];
/** Models fit to pick as a project's build model, i.e. everything except the vision-only helpers. */
export const BUILDABLE_MODEL_KEYS = MODEL_KEYS.filter((k) => MODELS[k].buildable !== false);

/** Projects created before the model picker stored "quality" / "fast" profiles. */
export function modelKeyFor(stored: string | null | undefined): ModelKey {
  if (stored && stored in MODELS) return stored as ModelKey;
  return stored === "fast" ? "glm-flash" : "glm";
}

/** Models to try, in order, when one fails before streaming anything. Same-provider options come first. */
export const FALLBACKS: Record<ModelKey, ModelKey[]> = {
  glm: ["glm-flash", "deepseek"],
  "glm-flash": ["glm", "deepseek"],
  deepseek: ["glm-flash", "glm"],
  omni: ["glm-flash", "glm"],
  muse: ["glm-flash", "glm"],
  "gpt-oss": ["glm-flash", "glm"],
  kimi: ["glm-flash", "glm"],
  "mistral-nemotron": ["glm-flash", "glm"],
  "nemotron-super": ["glm-flash", "glm"],
  "nemotron-lightning": ["glm-flash", "glm"],
  "nemotron-ultra": ["glm-flash", "glm"],
  gemma: ["glm-flash", "glm"],
  "deepseek-v4": ["glm-flash", "glm"],
  "llama-vision": ["glm-flash", "glm"],
};

const KEY_ENV = { nvidia: "NVIDIA_API_KEY", deepseek: "DEEPSEEK_API_KEY" } as const;
// A provider that rejected its key is skipped for a while instead of costing every call a failed round trip.
const badKeyUntil = new Map<ModelConfig["provider"], number>();
const BAD_KEY_MS = 10 * 60_000;
const keyOk = (k: ModelKey) => (badKeyUntil.get(MODELS[k].provider) ?? 0) < Date.now();

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};

export type ToolSchema = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatResult = {
  content: string;
  /** The model's reasoning stream, for providers that send one (reasoning_content). */
  reasoning: string;
  toolCalls: { id: string; name: string; args: string }[];
  finish: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

export type ChatOpts = {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  onToken?: (t: string) => void;
  onReasoning?: (t: string) => void;
  onToolDelta?: (index: number, name: string, args: string) => void;
  /** Absolute epoch ms; the whole call (including a fallback attempt) is cut off here. */
  deadline: number;
  signal?: AbortSignal;
  /** Don't retry on the registry's backup model (e.g. image input, which the text fallbacks can't read). */
  noFallback?: boolean;
  /** Per-call overrides, e.g. a small token/reasoning budget for quick reviews. */
  maxTokens?: number;
  extra?: Record<string, unknown>;
};

export class GatewayError extends Error {
  constructor(public status: number, body: string) {
    super(`gateway ${status}: ${body.slice(0, 500)}`);
  }
}

// A design file can take minutes to stream, so the per-attempt limit is on
// silence, not total length: a stream that keeps producing tokens runs until
// the caller's deadline.
const IDLE_TIMEOUT_MS = 45_000;

function baseFor(provider: ModelConfig["provider"]) {
  if (provider === "nvidia") {
    return { url: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1", key: process.env.NVIDIA_API_KEY ?? "" };
  }
  return { url: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com", key: process.env.DEEPSEEK_API_KEY ?? "" };
}

class IdleTimeout extends Error {
  name = "TimeoutError";
}

/**
 * Sampling settings a model insists on, learned from its own errors: some hosted models reject any other value
 * ("`top_p` is immutable for this model and must be 0.95, got 1"). Kept for the life of the server instance.
 */
const pinned = new Map<ModelKey, Record<string, number | boolean>>();

/** The setting and value a 400 says the model requires, if that's what it says. */
function requiredSetting(body: string): [string, number | boolean] | null {
  const m = /`?([a-z_]+)`?\s+is immutable for this model and must be\s+(-?[\d.]+|true|false)/i.exec(body);
  if (!m) return null;
  return [m[1], m[2] === "true" ? true : m[2] === "false" ? false : Number(m[2])];
}

async function chatOnce(modelKey: ModelKey, opts: ChatOpts, onFirstByte: () => void): Promise<ChatResult> {
  const m = MODELS[modelKey];
  const { url, key } = baseFor(m.provider);
  const ctrl = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(new IdleTimeout("model stopped responding")), IDLE_TIMEOUT_MS);
  };
  const hard = setTimeout(() => ctrl.abort(new IdleTimeout("turn deadline reached")), Math.max(1000, opts.deadline - Date.now()));
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort);
  armIdle();

  try {
    const send = () =>
      fetch(`${url}/chat/completions`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: m.id,
          messages: opts.messages,
          stream: true,
          temperature: m.temperature,
          top_p: m.top_p,
          max_tokens: opts.maxTokens ?? m.max_tokens,
          ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
          ...m.extra,
          ...opts.extra,
          ...pinned.get(modelKey),
        }),
      });
    let res = await send();
    // A model that only accepts one value for a sampling setting says which: use it, and remember it (up to 3 settings).
    for (let i = 0; i < 3 && res.status === 400; i++) {
      const text = await res.text();
      const need = requiredSetting(text);
      if (!need) throw new GatewayError(res.status, text);
      pinned.set(modelKey, { ...pinned.get(modelKey), [need[0]]: need[1] });
      console.log(`[gateway] ${m.id} requires ${need[0]}=${need[1]}; retrying with it`);
      res = await send();
    }
    if (!res.ok || !res.body) throw new GatewayError(res.status, await res.text());

    const out: ChatResult = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let first = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.usage) out.usage = chunk.usage;
        const c = chunk.choices?.[0];
        if (!c) continue;
        const d = c.delta ?? {};
        const thought = d.reasoning_content ?? d.reasoning;
        if (first && (d.content || d.tool_calls || thought)) {
          first = false;
          onFirstByte();
        }
        if (typeof thought === "string" && thought) {
          out.reasoning += thought;
          opts.onReasoning?.(thought);
        }
        if (d.content) {
          out.content += d.content;
          opts.onToken?.(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = (out.toolCalls[idx] ??= { id: "", name: "", args: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments;
            opts.onToolDelta?.(idx, slot.name, slot.args);
          }
        }
        if (c.finish_reason) out.finish = c.finish_reason;
      }
    }
    out.toolCalls = out.toolCalls.filter(Boolean);
    return out;
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(idle);
    clearTimeout(hard);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Chat with a one-shot fallback to the registry's backup model when the
 * primary provider fails before sending anything (auth error, rate limit,
 * 5xx, or silence). Once tokens have streamed to the user, a failure is
 * surfaced instead of silently restarting on another model.
 */
export async function chat(modelKey: ModelKey, opts: ChatOpts): Promise<ChatResult> {
  const chain = [modelKey, ...(opts.noFallback ? [] : FALLBACKS[modelKey])];
  const candidates = chain.filter(keyOk);
  if (!candidates.length) candidates.push(modelKey);
  let lastError: unknown;
  for (const key of candidates) {
    if (lastError && opts.deadline - Date.now() < 5000) break;
    let streamed = false;
    try {
      return await chatOnce(key, opts, () => (streamed = true));
    } catch (e) {
      lastError = e;
      if (e instanceof GatewayError && (e.status === 401 || e.status === 403)) badKeyUntil.set(MODELS[key].provider, Date.now() + BAD_KEY_MS);
      const timedOut = (e as any)?.name === "TimeoutError";
      const retryable = timedOut || (e instanceof GatewayError && (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 429 || e.status >= 500));
      if (streamed || opts.signal?.aborted || !retryable) break;
    }
  }
  if (lastError instanceof GatewayError && (lastError.status === 401 || lastError.status === 403)) {
    const provider = MODELS[candidates[candidates.length - 1]].provider;
    throw new Error(`The ${provider === "nvidia" ? "NVIDIA" : "DeepSeek"} API rejected its key. Check ${KEY_ENV[provider]} in your deployment's environment variables.`);
  }
  throw lastError;
}
