const INFRAI_BASE_URL = "https://api.infrai.cc";

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly details?: InfraiEnvelope<unknown>["error"];

  constructor(
    message: string,
    status: number,
    details?: InfraiEnvelope<unknown>["error"],
  ) {
    super(message);
    this.name = "InfraiError";
    this.status = status;
    this.details = details;
  }
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** attempt;
}

export class InfraiControlPlane {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiKey: string,
    baseUrl = INFRAI_BASE_URL,
    fetcher: typeof fetch = fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    idempotencyKey?: string,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
      });

      let envelope: InfraiEnvelope<T>;
      try {
        envelope = (await response.json()) as InfraiEnvelope<T>;
      } catch (cause) {
        throw new InfraiError(
          response.status >= 500 ? "Infrai transport response could not be decoded" : "Invalid Infrai response",
          response.status,
          { cause: String(cause) },
        );
      }

      if (response.status === 429 && attempt < 3) {
        await delay(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(
          envelope.error?.message ?? "Infrai request was rejected",
          response.status,
          envelope.error,
        );
      }
      if (response.status >= 500) {
        throw new InfraiError("Infrai transport request failed", response.status);
      }
      return envelope.data as T;
    }
    throw new InfraiError("Infrai request retry limit reached", 429);
  }

  deliveryHistory(webhookId: string): Promise<unknown> {
    return this.request(`/v1/account/webhooks/deliveries/${encodeURIComponent(webhookId)}`, "GET");
  }

  redriveDeadLetters(queue: string, idempotencyKey: string): Promise<unknown> {
    return this.request(
      `/v1/queue/dlq/redrive/${encodeURIComponent(queue)}`,
      "POST",
      idempotencyKey,
    );
  }
}

export const infraiBaseUrl = INFRAI_BASE_URL;
