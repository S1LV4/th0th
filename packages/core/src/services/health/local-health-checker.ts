/**
 * Local Health Checker
 *
 * Verifica a saúde de todos os serviços locais do th0th.
 * Usado para garantir que o sistema funciona 100% offline (local-first).
 *
 * Serviços verificados:
 * - Ollama (embeddings locais)
 * - SQLite databases (cache, keyword, vector, analytics, embedding-cache)
 * - Data directory (permissões de leitura/escrita)
 */

import { logger } from "@th0th-ai/shared";
import { config } from "@th0th-ai/shared";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

/**
 * Status individual de um serviço
 */
export interface ServiceStatus {
  available: boolean;
  latency?: number;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Resultado completo do health check
 */
export interface LocalHealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  mode: "local-first";
  timestamp: string;
  services: {
    ollama: ServiceStatus;
    dataDirectory: ServiceStatus;
    vectorStore: ServiceStatus;
    keywordSearch: ServiceStatus;
    cache: ServiceStatus;
    embeddingCache: ServiceStatus;
  };
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    failed: number;
  };
  recommendations: string[];
}

/**
 * Informações sobre modelos Ollama disponíveis
 */
export interface OllamaModelInfo {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export class LocalHealthChecker {
  private ollamaBaseUrl: string;
  private dataDir: string;

  constructor() {
    this.ollamaBaseUrl =
      process.env.OLLAMA_BASE_URL || "http://localhost:11434";
    this.dataDir = config.get("dataDir");
  }

  /**
   * Executa health check completo de todos os serviços locais
   */
  async checkAll(): Promise<LocalHealthReport> {
    const startTime = Date.now();

    const [ollama, dataDirectory, vectorStore, keywordSearch, cache, embeddingCache] =
      await Promise.all([
        this.checkOllama(),
        this.checkDataDirectory(),
        this.checkDatabase("vector-store.db"),
        this.checkDatabase("keyword-search.db"),
        this.checkDatabase("cache.db"),
        this.checkDatabase("embedding-cache.db"),
      ]);

    const services = {
      ollama,
      dataDirectory,
      vectorStore,
      keywordSearch,
      cache,
      embeddingCache,
    };

    const statuses = Object.values(services);
    const healthy = statuses.filter((s) => s.available).length;
    const failed = statuses.filter((s) => !s.available).length;
    const total = statuses.length;

    const recommendations = this.generateRecommendations(services);

    let status: "healthy" | "degraded" | "unhealthy";
    if (failed === 0) {
      status = "healthy";
    } else if (healthy > failed) {
      status = "degraded";
    } else {
      status = "unhealthy";
    }

    const report: LocalHealthReport = {
      status,
      mode: "local-first",
      timestamp: new Date().toISOString(),
      services,
      summary: {
        total,
        healthy,
        degraded: 0,
        failed,
      },
      recommendations,
    };

    const totalLatency = Date.now() - startTime;
    logger.info("Local health check completed", {
      status,
      healthy,
      failed,
      latency: totalLatency,
    });

    return report;
  }

  /**
   * Verifica se o Ollama está rodando e acessível
   */
  async checkOllama(): Promise<ServiceStatus> {
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.ollamaBaseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const latency = Date.now() - start;

      if (!response.ok) {
        return {
          available: false,
          latency,
          error: `Ollama responded with HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as {
        models?: OllamaModelInfo[];
      };

      const models = data.models || [];
      const embeddingModel =
        process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text:latest";
      const hasEmbeddingModel = models.some(
        (m) =>
          m.name === embeddingModel ||
          m.name.startsWith(embeddingModel.split(":")[0]),
      );

      return {
        available: true,
        latency,
        details: {
          url: this.ollamaBaseUrl,
          modelsAvailable: models.length,
          models: models.map((m) => m.name),
          embeddingModel,
          hasEmbeddingModel,
        },
      };
    } catch (error) {
      const latency = Date.now() - start;
      const message =
        error instanceof Error ? error.message : String(error);

      return {
        available: false,
        latency,
        error: message.includes("abort")
          ? "Ollama timeout (not running?)"
          : `Ollama unreachable: ${message}`,
      };
    }
  }

  /**
   * Verifica o diretório de dados (permissões de leitura/escrita)
   */
  async checkDataDirectory(): Promise<ServiceStatus> {
    const start = Date.now();

    try {
      // Verifica se o diretório existe
      if (!existsSync(this.dataDir)) {
        // Tenta criar
        await fs.mkdir(this.dataDir, { recursive: true });
      }

      // Verifica permissões de escrita
      const testFile = path.join(this.dataDir, ".health-check-test");
      await fs.writeFile(testFile, "ok", "utf-8");
      await fs.unlink(testFile);

      // Lista conteúdo
      const files = await fs.readdir(this.dataDir);
      const dbFiles = files.filter((f) => f.endsWith(".db"));

      const latency = Date.now() - start;

      return {
        available: true,
        latency,
        details: {
          path: this.dataDir,
          writable: true,
          totalFiles: files.length,
          databases: dbFiles,
        },
      };
    } catch (error) {
      const latency = Date.now() - start;
      return {
        available: false,
        latency,
        error: `Data directory error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Verifica se um banco SQLite existe e é acessível
   */
  async checkDatabase(dbName: string): Promise<ServiceStatus> {
    const start = Date.now();
    const dbPath = path.join(this.dataDir, dbName);

    try {
      if (!existsSync(dbPath)) {
        return {
          available: false,
          latency: Date.now() - start,
          error: `Database not found: ${dbPath}`,
          details: { path: dbPath, exists: false },
        };
      }

      const stats = await fs.stat(dbPath);
      const latency = Date.now() - start;

      return {
        available: true,
        latency,
        details: {
          path: dbPath,
          exists: true,
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          lastModified: stats.mtime.toISOString(),
        },
      };
    } catch (error) {
      const latency = Date.now() - start;
      return {
        available: false,
        latency,
        error: `Database check failed: ${(error as Error).message}`,
        details: { path: dbPath },
      };
    }
  }

  /**
   * Verifica apenas o Ollama (útil para startup rápido)
   */
  async isOllamaReady(): Promise<boolean> {
    const result = await this.checkOllama();
    return result.available;
  }

  /**
   * Lista modelos disponíveis no Ollama
   */
  async getOllamaModels(): Promise<string[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.ollamaBaseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) return [];

      const data = (await response.json()) as {
        models?: OllamaModelInfo[];
      };

      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Gera recomendações baseadas no estado dos serviços
   */
  private generateRecommendations(
    services: LocalHealthReport["services"],
  ): string[] {
    const recommendations: string[] = [];

    if (!services.ollama.available) {
      recommendations.push(
        "Install and start Ollama for local embeddings: curl -fsSL https://ollama.com/install.sh | sh && ollama serve",
      );
      recommendations.push(
        `Pull embedding model: ollama pull ${process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text:latest"}`,
      );
    } else if (
      services.ollama.details &&
      !(services.ollama.details as any).hasEmbeddingModel
    ) {
      recommendations.push(
        `Pull embedding model: ollama pull ${process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text:latest"}`,
      );
    }

    if (!services.dataDirectory.available) {
      recommendations.push(
        `Create data directory: mkdir -p ${this.dataDir}`,
      );
    }

    if (!services.vectorStore.available) {
      recommendations.push(
        "Index a project to create vector store: bun run start:api, then call index_project",
      );
    }

    if (!services.keywordSearch.available) {
      recommendations.push(
        "Keyword search DB will be created on first project index",
      );
    }

    if (!services.cache.available) {
      recommendations.push(
        "Cache DB will be created on first search operation",
      );
    }

    if (!services.embeddingCache.available) {
      recommendations.push(
        "Embedding cache DB will be created on first embedding request",
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        "All local services are healthy. System is ready for 100% offline operation.",
      );
    }

    return recommendations;
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i]
  );
}

/**
 * Singleton instance
 */
let healthCheckerInstance: LocalHealthChecker | null = null;

export function getHealthChecker(): LocalHealthChecker {
  if (!healthCheckerInstance) {
    healthCheckerInstance = new LocalHealthChecker();
  }
  return healthCheckerInstance;
}
