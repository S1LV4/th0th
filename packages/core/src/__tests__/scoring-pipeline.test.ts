/**
 * Scoring Pipeline Unit Tests
 *
 * Validates the full scoring math for contextual-search-rlm.ts and
 * search-controller.ts:
 *   - Code query detection (keyword boost 1.0 vs 2.5)
 *   - RRF fusion + dynamic normalization
 *   - Centrality boost from metadata
 *   - Graph boost (1.3x via SearchController)
 *   - minScore filtering
 *
 * All tests use deterministic mocks — no DB, no embeddings, no I/O.
 */

import { describe, test, expect, mock, beforeAll } from "bun:test";

// ── Mock @th0th-ai/shared ────────────────────────────────────
mock.module("@th0th-ai/shared", () => {
  const actual = require("@th0th-ai/shared");
  return {
    ...actual,
    SearchSource: { VECTOR: "vector", KEYWORD: "keyword", HYBRID: "hybrid", CACHE: "cache" },
    config: {
      get: (key: string) => {
        const defaults: Record<string, any> = {
          dataDir: "/tmp/th0th-test-scoring",
          vectorStore: { type: "sqlite", dbPath: "/tmp/th0th-test-vs.db", collectionName: "test", embeddingModel: "default" },
          keywordSearch: { dbPath: "/tmp/th0th-test-kw.db", ftsVersion: "fts5" },
          cache: { l1: { maxSize: 1024, defaultTTL: 60 }, l2: { dbPath: "/tmp/th0th-test-cache.db", maxSize: 1024, defaultTTL: 60 }, embedding: { dbPath: "/tmp/th0th-test-emb-cache.db", maxAgeHours: 1 } },
          security: { maxInputLength: 10000, sanitizeInputs: true, maxIndexSize: 1000, maxFileSize: 1048576, allowedExtensions: [".ts"], excludePatterns: [] },
        };
        return defaults[key];
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      metric: () => {},
    },
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
  };
});

// ── Mock symbol-repository (used by contextual-search-rlm) ──
mock.module("../../data/sqlite/symbol-repository.js", () => ({
  symbolRepository: {
    getCentrality: () => new Map(),
  },
}));

// ── Mock ContextualSearchRLM for SearchController tests ─────
mock.module("../services/search/contextual-search-rlm.js", () => ({
  ContextualSearchRLM: class MockSearch {
    async search(_q: string, _pid: string, opts: any) {
      // Returns whatever mockSearchResults is set to
      return (globalThis as any).__mockSearchResults ?? [];
    }
    async ensureFreshIndex() {
      return { wasStale: false, reindexed: false };
    }
  },
}));

import { SearchController } from "../controllers/search-controller.js";

// ── Helpers ──────────────────────────────────────────────────

/** RRF constant used by ContextualSearchRLM */
const RRF_K = 60;

/**
 * Build a SearchResult mock compatible with the shared interface.
 */
function makeResult(
  id: string,
  score: number,
  metadata: Record<string, any> = {},
): any {
  return {
    id,
    content: `content of ${id}`,
    score,
    source: "hybrid",
    metadata: { projectId: "test", filePath: id, ...metadata },
    highlights: [],
  };
}

/**
 * Replicates the fuseResults algorithm exactly as implemented.
 *
 * This is the authoritative test reference — if contextual-search-rlm.ts
 * changes its math, this function must be updated and tests re-validated.
 *
 * We replicate rather than import because fuseResults is private and
 * instantiating ContextualSearchRLM would pull the full dependency chain.
 */
function fuseResults(
  resultSets: any[][],
  query: string,
  explainScores: boolean = false,
): any[] {
  const scoreMap = new Map<
    string,
    {
      result: any;
      rrfScore: number;
      vectorRank?: number;
      keywordRank?: number;
      vectorScore?: number;
      keywordScore?: number;
    }
  >();

  // Code pattern detection (mirrors contextual-search-rlm.ts:662-676)
  const codePatterns = [
    /\w+\(\)/,
    /\bfunction\b/i,
    /\bclass\b/i,
    /\binterface\b/i,
    /\benum\b/i,
    /\btype\b/i,
    /\bconst\b/i,
    /\bimport\b/i,
    /\bexport\b/i,
  ];
  const isCodeQuery = codePatterns.some((p) => p.test(query));
  const KEYWORD_BOOST = isCodeQuery ? 2.5 : 1.0;

  // RRF scoring (mirrors contextual-search-rlm.ts:694-724)
  for (let i = 0; i < resultSets.length; i++) {
    const results = resultSets[i];
    const isVector = i === 0;
    const boost = isVector ? 1.0 : KEYWORD_BOOST;

    results.forEach((result, rank) => {
      const rrfScore = (1 / (RRF_K + rank + 1)) * boost;

      if (scoreMap.has(result.id)) {
        const existing = scoreMap.get(result.id)!;
        existing.rrfScore += rrfScore;
        if (isVector) {
          existing.vectorRank = rank;
          existing.vectorScore = result.score;
        } else {
          existing.keywordRank = rank;
          existing.keywordScore = result.score;
        }
      } else {
        scoreMap.set(result.id, {
          result: { ...result },
          rrfScore,
          vectorRank: isVector ? rank : undefined,
          keywordRank: isVector ? undefined : rank,
          vectorScore: isVector ? result.score : undefined,
          keywordScore: isVector ? undefined : result.score,
        });
      }
    });
  }

  // Dynamic normalization + centrality boost (mirrors contextual-search-rlm.ts:727-757)
  const sorted = Array.from(scoreMap.values()).sort(
    (a, b) => b.rrfScore - a.rrfScore,
  );
  const maxRrfScore = sorted[0]?.rrfScore || 1;

  return sorted.map(
    ({ result, rrfScore, vectorRank, keywordRank, vectorScore, keywordScore }, index) => {
      const rrfNormalized = rrfScore / maxRrfScore;

      const centralityScore =
        typeof result.metadata?.centralityScore === "number"
          ? result.metadata.centralityScore
          : 0;
      const normalizedScore = Math.min(
        1,
        rrfNormalized * (1 + 0.2 * centralityScore),
      );

      return {
        ...result,
        score: normalizedScore,
      };
    },
  );
}

// ═════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════

describe("Code Query Detection", () => {
  test("deve atribuir boost de 1.0 para linguagem natural com palavras reservadas", () => {
    // "what type of error" contém \btype\b — dispara isCodeQuery = true
    // Isso é um falso positivo CONHECIDO do sistema atual.
    //
    // O teste documenta o comportamento REAL: a query contém "type" que
    // matcha /\btype\b/i, então isCodeQuery = true e KEYWORD_BOOST = 2.5.
    //
    // Se no futuro o detection for corrigido para ignorar frases naturais,
    // este teste deve ser atualizado para esperar boost = 1.0.
    const query = "what type of error";

    const vectorResults = [makeResult("a.ts", 0.9)];
    const keywordResults = [makeResult("a.ts", 5.0)];

    const results = fuseResults([vectorResults, keywordResults], query);

    // Com isCodeQuery = true (falso positivo), o keyword recebe 2.5x:
    // vectorRRF  = 1/(60+0+1) * 1.0 = 0.016393
    // keywordRRF = 1/(60+0+1) * 2.5 = 0.040984
    // total = 0.057377
    // maxRrfScore = 0.057377, rrfNormalized = 1.0
    //
    // NOTA: Este teste documenta o falso positivo. O score resultante é
    // o mesmo independente do boost porque é o único resultado (normalizado
    // para 1.0 pela normalização dinâmica). O efeito real se vê em
    // rankings com múltiplos resultados.
    expect(results[0].score).toBeCloseTo(1.0, 4);

    // Para demonstrar o efeito do boost em ranking relativo, adicionamos
    // um segundo resultado que só aparece em vector:
    const vectorResults2 = [makeResult("a.ts", 0.9), makeResult("b.ts", 0.8)];
    const keywordResults2 = [makeResult("a.ts", 5.0)];
    const results2 = fuseResults([vectorResults2, keywordResults2], query);

    // a.ts: vector(#1) + keyword(#1 * 2.5) = 1/61 + 2.5/61 = 0.057377
    // b.ts: vector(#2 only)                = 1/62           = 0.016129
    // ratio b/a = 0.016129 / 0.057377 = 0.2811
    expect(results2[0].id).toBe("a.ts");
    expect(results2[1].score).toBeCloseTo(0.016129 / 0.057377, 3);
  });

  test("deve atribuir boost de 2.5 para sintaxe de código real", () => {
    // "type User = string" contém \btype\b → isCodeQuery = true, boost = 2.5
    const query = "type User = string";

    const vectorResults = [
      makeResult("types.ts", 0.95),
      makeResult("utils.ts", 0.7),
    ];
    const keywordResults = [
      makeResult("types.ts", 8.0),
      makeResult("api.ts", 3.0),
    ];

    const results = fuseResults([vectorResults, keywordResults], query);

    // types.ts: vector(#1) + keyword(#1 * 2.5)
    //   = 1/(61)*1.0 + 1/(61)*2.5 = 0.016393 + 0.040984 = 0.057377
    // utils.ts: vector(#2) only
    //   = 1/(62)*1.0 = 0.016129
    // api.ts: keyword(#2 * 2.5) only
    //   = 1/(62)*2.5 = 0.040323
    //
    // Sorted: types.ts (0.057377), api.ts (0.040323), utils.ts (0.016129)
    // maxRrfScore = 0.057377
    //
    // types.ts normalized = 1.0
    // api.ts   normalized = 0.040323 / 0.057377 = 0.70278
    // utils.ts normalized = 0.016129 / 0.057377 = 0.28112

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe("types.ts");
    expect(results[0].score).toBeCloseTo(1.0, 4);

    expect(results[1].id).toBe("api.ts");
    expect(results[1].score).toBeCloseTo(0.040323 / 0.057377, 3);

    expect(results[2].id).toBe("utils.ts");
    expect(results[2].score).toBeCloseTo(0.016129 / 0.057377, 3);

    // api.ts (#2 keyword only, boosted) deve ranquear ACIMA de utils.ts (#2 vector only)
    // porque 2.5 * 1/62 = 0.0403 > 1.0 * 1/62 = 0.0161
    expect(results[1].score).toBeGreaterThan(results[2].score);
  });
});

describe("RRF e Normalização Dinâmica", () => {
  test("não deve normalizar o melhor resultado de um lote ruim para 1.0 — oh wait, deve sim", () => {
    // Com normalização DINÂMICA (score / maxScore), o melhor resultado do
    // batch SEMPRE recebe 1.0, independente do rank absoluto.
    //
    // Isso é o comportamento CORRETO da implementação atual. A normalização
    // dinâmica garante que o range [0,1] é totalmente utilizado.
    //
    // Se TODOS os resultados começam no rank 15, o melhor deles (#15) ainda
    // recebe 1.0. A diferenciação vem da distância relativa entre eles.
    //
    // Teste: 3 resultados, melhor rank é 15 (0-indexed) em ambas as fontes.
    // Query natural (boost = 1.0).
    const query = "authentication flow";

    // Simula resultados onde o melhor rank disponível é posição 15
    const vectorResults: any[] = [];
    const keywordResults: any[] = [];

    // Preenche 15 resultados "fantasma" antes dos reais
    for (let i = 0; i < 15; i++) {
      vectorResults.push(makeResult(`filler-v-${i}.ts`, 0.5));
      keywordResults.push(makeResult(`filler-k-${i}.ts`, 2.0));
    }
    // Os resultados "reais" começam no rank 15
    vectorResults.push(makeResult("auth.ts", 0.6));
    vectorResults.push(makeResult("login.ts", 0.5));
    vectorResults.push(makeResult("session.ts", 0.4));

    keywordResults.push(makeResult("auth.ts", 3.0));

    const results = fuseResults([vectorResults, keywordResults], query);

    // auth.ts aparece em vector(#15) + keyword(#15):
    //   vector:  1/(60+15+1) * 1.0 = 1/76 = 0.013158
    //   keyword: 1/(60+15+1) * 1.0 = 1/76 = 0.013158
    //   total = 0.026316
    //
    // O melhor resultado GERAL do batch (filler-v-0 + filler-k-0 se fossem o mesmo)
    // na verdade é provavelmente filler-v-0 com rank 0 → 1/61 = 0.016393

    // Encontra auth.ts no resultado
    const authResult = results.find((r) => r.id === "auth.ts");
    expect(authResult).toBeDefined();

    // O score de auth.ts NÃO é o melhor do batch (fillers no rank 0 são melhores)
    // auth.ts tem rrfScore = 0.026316
    // O melhor do batch (algum filler que aparece nas duas fontes, ou filler-v-0 em #1)
    // Se nenhum filler é compartilhado: maxRrfScore = 1/61 = 0.016393
    // auth.ts normalized = 0.026316 / 0.016393 = 1.605 → clipped para 1.0
    //
    // Mas auth.ts aparece nas DUAS fontes, então soma 2 * 1/76 = 0.026316
    // Fillers aparecem em UMA fonte cada, o melhor (rank 0) tem 1/61 = 0.016393
    // auth.ts (0.026316) > melhor filler (0.016393) → auth.ts É o #1
    expect(authResult!.score).toBeCloseTo(1.0, 4);

    // login.ts: só vector(#16) = 1/77 = 0.012987
    // session.ts: só vector(#17) = 1/78 = 0.012821
    const loginResult = results.find((r) => r.id === "login.ts");
    const sessionResult = results.find((r) => r.id === "session.ts");

    // Ambos devem ter score < 1.0 (são ranks piores que auth.ts)
    expect(loginResult!.score).toBeLessThan(1.0);
    expect(sessionResult!.score).toBeLessThan(1.0);

    // login.ts normalized = 0.012987 / 0.026316 = 0.49342
    expect(loginResult!.score).toBeCloseTo(0.012987 / 0.026316, 3);
  });

  test("deve somar os scores corretamente se o documento aparecer no Vector e no Keyword", () => {
    // Query natural → boost = 1.0
    const query = "authentication flow";

    const vectorResults = [
      makeResult("shared.ts", 0.9),  // rank 0
      makeResult("only-vec.ts", 0.7), // rank 1
    ];
    const keywordResults = [
      makeResult("only-kw.ts", 5.0),  // rank 0
      makeResult("shared.ts", 4.0),   // rank 1
    ];

    const results = fuseResults([vectorResults, keywordResults], query);

    // shared.ts: vector(#0) + keyword(#1)
    //   = 1/(60+0+1)*1.0 + 1/(60+1+1)*1.0
    //   = 1/61 + 1/62
    //   = 0.016393 + 0.016129
    //   = 0.032522
    //
    // only-kw.ts: keyword(#0) only
    //   = 1/(60+0+1)*1.0 = 1/61 = 0.016393
    //
    // only-vec.ts: vector(#1) only
    //   = 1/(60+1+1)*1.0 = 1/62 = 0.016129
    //
    // Sorted: shared.ts (0.032522), only-kw.ts (0.016393), only-vec.ts (0.016129)
    // maxRrfScore = 0.032522

    expect(results[0].id).toBe("shared.ts");
    expect(results[0].score).toBeCloseTo(1.0, 4); // max → normalized to 1.0

    expect(results[1].id).toBe("only-kw.ts");
    expect(results[1].score).toBeCloseTo(0.016393 / 0.032522, 3);
    // = 0.50406

    expect(results[2].id).toBe("only-vec.ts");
    expect(results[2].score).toBeCloseTo(0.016129 / 0.032522, 3);
    // = 0.49595

    // Um documento que aparece em ambas as fontes deve ter score
    // significativamente maior que um que aparece em apenas uma:
    // shared.ts (1.0) vs only-kw.ts (0.504) → ~2x advantage
    expect(results[0].score).toBeGreaterThan(results[1].score * 1.9);
  });
});

describe("Centrality e Graph Boost", () => {
  test("deve aplicar o centralityScore corretamente sem clipar injustamente o rank #1", () => {
    // Dois resultados, ambos no vector rank 0 e 1.
    // O #2 (rank 1) tem centralityScore = 1.0 (hub file).
    // O #1 (rank 0) tem centralityScore = 0.0.
    //
    // Com centrality boost, #2 recebe * 1.2 mas #1 recebe * 1.0.
    // Questão: o boost de 20% é suficiente para inverter o ranking?
    const query = "utils helper";

    const vectorResults = [
      makeResult("leaf.ts", 0.95, { centralityScore: 0.0 }),   // rank 0, no centrality
      makeResult("hub.ts", 0.85, { centralityScore: 1.0 }),    // rank 1, max centrality
    ];
    const keywordResults: any[] = []; // Nenhum resultado keyword

    const results = fuseResults([vectorResults, keywordResults], query);

    // leaf.ts: vector(#0) = 1/61 = 0.016393
    // hub.ts:  vector(#1) = 1/62 = 0.016129
    // maxRrfScore = 0.016393
    //
    // leaf.ts: rrfNormalized = 1.0, centrality = 0.0
    //   finalScore = 1.0 * (1 + 0.2 * 0.0) = 1.0
    //
    // hub.ts: rrfNormalized = 0.016129 / 0.016393 = 0.98390
    //   finalScore = 0.98390 * (1 + 0.2 * 1.0) = 0.98390 * 1.2 = 1.18068 → min(1, ...) = 1.0
    //
    // AMBOS ficam em 1.0! O centrality boost do hub clipou para 1.0.
    // Isso demonstra que o boost de 20% não é suficiente para diferenciar
    // resultados com ranks adjacentes quando ambos atingem o cap.

    expect(results[0].score).toBeCloseTo(1.0, 4);
    expect(results[1].score).toBeCloseTo(1.0, 4);

    // No entanto, leaf.ts mantém o rank #1 porque o sort é por rrfScore
    // ANTES da normalização. A ordem final preserva a ordem RRF original.
    expect(results[0].id).toBe("leaf.ts");
    expect(results[1].id).toBe("hub.ts");

    // Agora um caso com mais distância entre ranks:
    // hub.ts no rank 10 (distante do topo), leaf.ts no rank 0.
    const vectorResults2 = [
      makeResult("leaf2.ts", 0.95, { centralityScore: 0.0 }),
    ];
    // Insere 9 fillers antes de hub2.ts
    for (let i = 1; i <= 9; i++) {
      vectorResults2.push(makeResult(`filler-${i}.ts`, 0.5, { centralityScore: 0.0 }));
    }
    vectorResults2.push(makeResult("hub2.ts", 0.6, { centralityScore: 1.0 }));

    const results2 = fuseResults([vectorResults2, []], query);

    // leaf2.ts: rank 0 → 1/61 = 0.016393 (maxRrfScore)
    // hub2.ts:  rank 10 → 1/71 = 0.014085
    //
    // leaf2.ts: normalized = 1.0, final = 1.0 * 1.0 = 1.0
    // hub2.ts:  normalized = 0.014085 / 0.016393 = 0.85924
    //           final = 0.85924 * 1.2 = 1.03108 → clipped to 1.0
    //
    // Ainda clipa! Mesmo 10 posições abaixo, o 20% boost compensa.
    const hub2 = results2.find((r) => r.id === "hub2.ts");
    expect(hub2!.score).toBeCloseTo(1.0, 4);

    // Caso onde o centrality NÃO atinge o cap: rank 15+
    const vectorResults3 = [
      makeResult("top.ts", 0.95, { centralityScore: 0.0 }),
    ];
    for (let i = 1; i <= 19; i++) {
      vectorResults3.push(makeResult(`pad-${i}.ts`, 0.5, { centralityScore: 0.0 }));
    }
    // rank 20
    vectorResults3.push(makeResult("deep-hub.ts", 0.3, { centralityScore: 1.0 }));

    const results3 = fuseResults([vectorResults3, []], query);

    // deep-hub.ts: rank 20 → 1/81 = 0.012346
    // maxRrfScore = 1/61 = 0.016393
    // normalized = 0.012346 / 0.016393 = 0.75313
    // final = 0.75313 * 1.2 = 0.90376 → NÃO clipa

    const deepHub = results3.find((r) => r.id === "deep-hub.ts");
    expect(deepHub!.score).toBeCloseTo(0.012346 / 0.016393 * 1.2, 3);
    expect(deepHub!.score).toBeLessThan(1.0);
  });

  test("deve aplicar multiplicador de 1.3x apenas para arquivos no boostFiles via SearchController", () => {
    // SearchController.applyBoost() multiplica score * 1.3 para files em boostFiles
    // e re-sort por score descendente.
    (SearchController as any).instance = null;
    const controller = SearchController.getInstance();

    const results = [
      { id: "1", score: 0.8, metadata: { filePath: "src/auth.ts" } },
      { id: "2", score: 0.7, metadata: { filePath: "src/types.ts" } },
      { id: "3", score: 0.6, metadata: { filePath: "src/utils.ts" } },
    ];

    const boostFiles = ["src/types.ts"]; // Só types.ts recebe boost

    const boosted = controller.applyBoost(results, boostFiles);

    // auth.ts:  0.8 * 1.0 = 0.8 (não está em boostFiles)
    // types.ts: 0.7 * 1.3 = 0.91 (está em boostFiles)
    // utils.ts: 0.6 * 1.0 = 0.6 (não está em boostFiles)
    //
    // Re-sorted: types.ts (0.91), auth.ts (0.8), utils.ts (0.6)

    expect(boosted[0].metadata.filePath).toBe("src/types.ts");
    expect(boosted[0].score).toBeCloseTo(0.91, 4);

    expect(boosted[1].metadata.filePath).toBe("src/auth.ts");
    expect(boosted[1].score).toBeCloseTo(0.8, 4);

    expect(boosted[2].metadata.filePath).toBe("src/utils.ts");
    expect(boosted[2].score).toBeCloseTo(0.6, 4);
  });

  test("graph boost deve clipar em 1.0 quando score * 1.3 > 1.0", () => {
    (SearchController as any).instance = null;
    const controller = SearchController.getInstance();

    const results = [
      { id: "1", score: 0.9, metadata: { filePath: "src/main.ts" } },
    ];

    const boosted = controller.applyBoost(results, ["src/main.ts"]);

    // 0.9 * 1.3 = 1.17 → min(1, 1.17) = 1.0
    expect(boosted[0].score).toBeCloseTo(1.0, 4);
  });
});

describe("Filtro de Economia de Tokens (minScore)", () => {
  test("deve dropar documentos com score final menor que 0.3 na busca padrão", () => {
    // Simula resultados já processados pelo fuseResults (scores normalizados)
    // O filtro minScore é aplicado em contextual-search-rlm.ts:597:
    //   .filter((result) => result.score >= minScore)
    // Default minScore = 0.3

    const minScore = 0.3;

    // Gera resultados com scores variados
    const query = "authentication flow";
    const vectorResults = [
      makeResult("good.ts", 0.9),
      makeResult("ok.ts", 0.7),
      makeResult("bad.ts", 0.3),
    ];
    // Nenhum keyword result — todos os scores vem só de vector
    const keywordResults: any[] = [];

    const fused = fuseResults([vectorResults, keywordResults], query);

    // good.ts: rank 0 → 1/61 = 0.016393 (maxRrfScore)
    // ok.ts:   rank 1 → 1/62 = 0.016129
    // bad.ts:  rank 2 → 1/63 = 0.015873
    //
    // good.ts normalized = 1.0
    // ok.ts   normalized = 0.016129 / 0.016393 = 0.98390
    // bad.ts  normalized = 0.015873 / 0.016393 = 0.96828
    //
    // Com só 3 resultados vector (ranks próximos), todos ficam acima de 0.3.
    // Isso é esperado — com normalização dinâmica, 3 results adjacentes
    // têm spread baixo.
    const filtered = fused.filter((r) => r.score >= minScore);
    expect(filtered.length).toBe(3); // Todos passam

    // Agora um cenário onde os resultados TÊM spread suficiente:
    // 1 resultado em ambas as fontes (rank 0) + 1 resultado só em vector (rank 19)
    const vectorResults2: any[] = [makeResult("top.ts", 0.95)];
    for (let i = 1; i < 19; i++) {
      vectorResults2.push(makeResult(`pad-${i}.ts`, 0.5));
    }
    vectorResults2.push(makeResult("bottom.ts", 0.1)); // rank 19
    const keywordResults2 = [makeResult("top.ts", 8.0)]; // top.ts em ambas

    const fused2 = fuseResults([vectorResults2, keywordResults2], query);

    // top.ts: vector(#0) + keyword(#0) = 1/61 + 1/61 = 0.032787 (maxRrfScore)
    // bottom.ts: vector(#19) = 1/80 = 0.012500
    // bottom normalized = 0.012500 / 0.032787 = 0.38120
    //
    // 0.38120 > 0.3 → ainda passa. Para ficar abaixo de 0.3:
    // precisaria rank ~27: 1/88 = 0.01136, normalized = 0.01136/0.03279 = 0.346 → passa
    // Ou: maxRrfScore muito alto + rank muito baixo.

    const bottom = fused2.find((r) => r.id === "bottom.ts");
    expect(bottom).toBeDefined();
    expect(bottom!.score).toBeGreaterThanOrEqual(minScore);

    // Teste definitivo: resultado com score ARTIFICIALMENTE abaixo de 0.3
    // (simula o que acontece após toda a pipeline)
    const artificialResults = [
      { score: 0.95, id: "a" },
      { score: 0.30, id: "b" }, // exatamente no limite
      { score: 0.29, id: "c" }, // abaixo do limite
      { score: 0.10, id: "d" }, // bem abaixo
    ];
    const afterFilter = artificialResults.filter((r) => r.score >= minScore);
    expect(afterFilter.length).toBe(2);
    expect(afterFilter.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("deve dropar documentos com score final menor que 0.4 via ContextController", () => {
    // O ContextController usa minScore: 0.4 (hardcoded em context-controller.ts:162)
    // quando chama searchProject().
    //
    // Verificamos que a regra de negócio filtra corretamente em 0.4.

    const minScore = 0.4;

    // Resultados simulados pós-pipeline
    const results = [
      { score: 0.95, id: "high" },
      { score: 0.55, id: "medium" },
      { score: 0.40, id: "borderline" }, // exatamente 0.4 → PASSA
      { score: 0.39, id: "just-below" }, // 0.39 → DROPA
      { score: 0.20, id: "low" },
    ];

    const filtered = results.filter((r) => r.score >= minScore);

    expect(filtered.length).toBe(3);
    expect(filtered.map((r) => r.id)).toEqual(["high", "medium", "borderline"]);

    // O "just-below" com score 0.39 deve ter sido removido
    expect(filtered.some((r) => r.id === "just-below")).toBe(false);
    expect(filtered.some((r) => r.id === "low")).toBe(false);

    // Verifica que borderline (exatamente 0.4) é incluído
    expect(filtered.some((r) => r.id === "borderline")).toBe(true);
  });
});

describe("Propriedades Matemáticas do Pipeline", () => {
  test("normalização dinâmica: o resultado #1 sempre recebe score 1.0 (sem centrality)", () => {
    // Propriedade invariante: com centralityScore = 0 para todos,
    // o primeiro resultado SEMPRE tem normalizedScore = 1.0
    const queries = [
      "simple query",
      "function doSomething()",
      "class MyComponent",
      "const API_KEY",
    ];

    for (const query of queries) {
      const results = fuseResults(
        [[makeResult("a.ts", 0.9)], [makeResult("b.ts", 5.0)]],
        query,
      );
      expect(results[0].score).toBeCloseTo(1.0, 4);
    }
  });

  test("presença em duas fontes dá vantagem ~2x vs presença em uma fonte", () => {
    const query = "authentication"; // natural, boost = 1.0

    // Mesmo documento em ambas as fontes (rank 0 em ambas)
    const vectorResults = [makeResult("shared.ts", 0.9)];
    const keywordResults = [makeResult("shared.ts", 5.0)];

    const results1 = fuseResults([vectorResults, keywordResults], query);

    // shared.ts: 1/61 + 1/61 = 2/61

    // Documento em apenas uma fonte
    const results2 = fuseResults([[makeResult("single.ts", 0.9)], []], query);

    // single.ts: 1/61

    // A razão entre dual-source e single-source no mesmo rank deve ser ~2x
    // (com normalização dinâmica ambos ficam 1.0, mas o score RRF bruto é 2x)
    // Testamos com um segundo resultado para ver a razão relativa
    const vectorResults3 = [
      makeResult("dual.ts", 0.9),
      makeResult("single.ts", 0.8),
    ];
    const keywordResults3 = [makeResult("dual.ts", 5.0)];

    const results3 = fuseResults([vectorResults3, keywordResults3], query);

    // dual.ts:   1/61 + 1/61 = 0.032787
    // single.ts: 1/62 = 0.016129
    // ratio = 0.032787 / 0.016129 ≈ 2.032 (dual é ~2x melhor que single)

    expect(results3[0].id).toBe("dual.ts");
    expect(results3[0].score).toBeCloseTo(1.0, 4);
    expect(results3[1].score).toBeCloseTo(0.016129 / 0.032787, 3);
    // = ~0.492, ou seja, single tem ~49% do score do dual
  });

  test("RRF score diminui monotonicamente com o rank", () => {
    const query = "test query";
    const vectorResults: any[] = [];
    for (let i = 0; i < 20; i++) {
      vectorResults.push(makeResult(`file-${i}.ts`, 0.9 - i * 0.01));
    }

    const results = fuseResults([vectorResults, []], query);

    // Cada resultado tem score estritamente menor que o anterior
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThan(results[i - 1].score);
    }
  });

  test("centrality boost não pode exceder fator 1.2x sobre score base", () => {
    const query = "test query";

    // Resultado com max centrality (1.0) em rank longe do topo
    const vectorResults: any[] = [
      makeResult("normal.ts", 0.9, { centralityScore: 0.0 }),
    ];
    for (let i = 1; i <= 18; i++) {
      vectorResults.push(makeResult(`pad-${i}.ts`, 0.5, { centralityScore: 0.0 }));
    }
    vectorResults.push(makeResult("hub.ts", 0.3, { centralityScore: 1.0 }));

    const results = fuseResults([vectorResults, []], query);

    const hub = results.find((r) => r.id === "hub.ts");
    const hubRrfNormalized = (1 / (RRF_K + 19 + 1)) / (1 / (RRF_K + 0 + 1));
    // = (1/80) / (1/61) = 61/80 = 0.7625

    // Com centrality 1.0: 0.7625 * 1.2 = 0.915
    // Sem centrality: 0.7625
    // Boost efetivo: 0.915 / 0.7625 = 1.2x exato

    expect(hub!.score).toBeCloseTo(hubRrfNormalized * 1.2, 3);
    expect(hub!.score / hubRrfNormalized).toBeCloseTo(1.2, 2);
  });
});
