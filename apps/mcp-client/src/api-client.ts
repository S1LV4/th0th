/**
 * API Client
 *
 * HTTP client para comunicação com a Tools API.
 * Implementa retry, timeout e error handling.
 */

export interface ApiClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config?: Partial<ApiClientConfig>) {
    this.baseUrl =
      config?.baseUrl || process.env.TH0TH_API_URL || "http://localhost:3333";
    this.apiKey = config?.apiKey || process.env.TH0TH_API_KEY || "";
    this.timeoutMs = config?.timeoutMs || 30000;
    this.maxRetries = config?.maxRetries || 2;
  }

  /**
   * POST request to Tools API
   */
  async post(endpoint: string, body: unknown): Promise<unknown> {
    return this.request("POST", endpoint, body);
  }

  /**
   * GET request to Tools API with optional query parameters
   */
  async get(endpoint: string, queryParams?: Record<string, unknown>): Promise<unknown> {
    let url = endpoint;
    if (queryParams && Object.keys(queryParams).length > 0) {
      const qs = new URLSearchParams(
        Object.entries(queryParams)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, String(v)] as [string, string])
      ).toString();
      if (qs) url = `${endpoint}?${qs}`;
    }
    return this.request("GET", url);
  }

  /**
   * Generic HTTP request to Tools API
   */
  private async request(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.apiKey) {
          headers["X-API-Key"] = this.apiKey;
        }

        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`API error ${response.status}: ${errorBody}`);
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;

        // Don't retry on client errors (4xx)
        if (lastError.message.includes("API error 4")) {
          throw lastError;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 500),
          );
        }
      }
    }

    throw lastError || new Error("Unknown API error");
  }

  /**
   * Health check da Tools API
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
