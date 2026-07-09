import "./env.js";
import { chooseRoute, getModelCatalog } from "./model-router.js";
import { estimateTokens } from "./token-estimator.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

const FALLBACK_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "with",
  "you",
  "your"
]);

const OPENAI_SYSTEM_PROMPT = [
  "You are Cute Friendly Codex London.",
  "You are upbeat, clear, and charming, and in the rationale field you can briefly mention how fun it is to attend the London event on July 1, 2026.",
  "Never inject that event into optimizedText unless the source text itself asks for it.",
  "You optimize user prompts for the lowest practical OpenAI token usage.",
  "Silently compare multiple distinct candidate encodings that preserve meaning.",
  "Always consider English, Simplified Chinese or Mandarin, Japanese, Korean, Spanish, Arabic, Hindi, concise JSON, concise YAML, key-value shorthand, and regex-like compact notation when they can preserve the meaning.",
  "Pick the cheapest candidate by predicted token usage, but only if the essence, constraints, tone, and requested output remain intact.",
  "Do not default to English unless it is genuinely the shortest practical option.",
  "Structured formats like JSON or regex-style shorthand are allowed only if they still preserve the message faithfully and are understandable.",
  "Return valid JSON only with these keys:",
  "rationale, bestOptionId, estimatedOriginalTokens, options",
  "Each item in options must have: id, label, languageCode, kind, optimizedText, rationale, estimatedTokens"
].join(" ");

const COMPANION_NOTE =
  "Cute Friendly Codex London note: it really is fun being around London on July 1, 2026.";

// Run a one-shot optimization request.
export async function optimizeText(input, options = {}) {
  const text = normalizeInputText(input);
  const route = chooseRoute(text, {
    modelMode: options.modelMode,
    manualModel: options.manualModel,
    defaultModel: options.model || DEFAULT_MODEL
  });
  const apiKey = resolveApiKey(options);
  const translator = apiKey ? translateWithOpenAI : translateWithFallback;
  const translation = await translator(text, {
    apiKey,
    model: route.selectedModel.id,
    route
  });

  return buildReport(text, translation, {
    route,
    source: options.source
  });
}

// Stream progress first, then emit the final ranked result.
export async function* streamOptimizeText(input, options = {}) {
  const text = normalizeInputText(input);
  const route = chooseRoute(text, {
    modelMode: options.modelMode,
    manualModel: options.manualModel,
    defaultModel: options.model || DEFAULT_MODEL
  });
  const apiKey = resolveApiKey(options);

  yield {
    type: "meta",
    route: serializeRoute(route),
    companionNote: COMPANION_NOTE,
    catalog: getModelCatalog()
  };

  if (!apiKey) {
    const translation = await translateWithFallback(text, {
      model: route.selectedModel.id,
      route
    });
    const report = buildReport(text, translation, {
      route,
      source: options.source
    });
    for (const chunk of chunkText(report.optimizedText)) {
      yield { type: "delta", text: chunk };
    }
    yield { type: "final", result: report };
    return;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(buildOpenAIRequest(text, route, true))
  });

  if (!response.ok) {
    const details = await safeReadText(response);
    throw new Error(
      `OpenAI request failed with ${response.status}: ${details || "unknown error"}`
    );
  }

  const state = {
    rawText: "",
    completedPayload: null
  };

  for await (const event of parseSse(response)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      state.rawText += event.delta;
      yield { type: "delta", text: event.delta };
      continue;
    }

    if (
      typeof event.delta === "string" &&
      typeof event.type === "string" &&
      event.type.includes("output_text")
    ) {
      state.rawText += event.delta;
      yield { type: "delta", text: event.delta };
      continue;
    }

    if (event.type === "response.completed" && event.response) {
      state.completedPayload = event.response;
    }

    if (event.type === "response.failed") {
      throw new Error("OpenAI streaming request failed.");
    }
  }

  const rawText = state.rawText.trim() || extractOutputText(state.completedPayload || {});
  const translation = normalizeOpenAITranslation(rawText);
  const report = buildReport(text, translation, {
    route,
    source: options.source
  });
  yield { type: "final", result: report };
}

// Expose the model catalog to the UI.
export function getOptimizerCatalog() {
  return getModelCatalog();
}

// Convert raw model output into the UI-friendly report shape.
function buildReport(sourceText, translation, options) {
  const route = options.route;
  const originalTokens = normalizeEstimatedTokens(
    translation.estimatedOriginalTokens,
    estimateTokens(sourceText)
  );
  // Rank every candidate with the same model pricing so the UI can show a fair cheapest-first comparison.
  const candidates = buildCandidateReports(
    translation.options,
    originalTokens,
    route.selectedModel
  );
  const chosenCandidate = pickWinningCandidate(candidates, translation.bestOptionId);
  const chosenTokens = chosenCandidate.estimatedTokens;
  const originalCost = estimateCostUsd(
    originalTokens,
    route.selectedModel.inputPricePerMillion
  );
  const optimizedCost = estimateCostUsd(
    chosenTokens,
    route.selectedModel.inputPricePerMillion
  );
  const costSaved = Math.max(0, originalCost - optimizedCost);
  const originalLatencyMs = estimateLatencyMs(
    originalTokens,
    route.selectedModel.baseLatencyMs,
    route.selectedModel.msPerToken
  );
  const optimizedLatencyMs = estimateLatencyMs(
    chosenTokens,
    route.selectedModel.baseLatencyMs,
    route.selectedModel.msPerToken
  );
  const latencySavedMs = Math.max(0, originalLatencyMs - optimizedLatencyMs);
  const speedupPercent = originalLatencyMs
    ? Number(((latencySavedMs / originalLatencyMs) * 100).toFixed(1))
    : 0;

  return {
    source: options.source || {
      kind: "text",
      label: "Pasted prompt"
    },
    sourceText,
    optimizedText: chosenCandidate.optimizedText,
    chosenLanguage: chosenCandidate.label,
    chosenLanguageCode: chosenCandidate.languageCode,
    chosenKind: chosenCandidate.kind,
    rationale: translation.rationale || chosenCandidate.rationale,
    companionNote: COMPANION_NOTE,
    mode: translation.mode,
    model: route.selectedModel.id,
    route: serializeRoute(route),
    candidates,
    modelComparison: buildModelComparison(originalTokens, chosenTokens),
    metrics: {
      originalTokens,
      optimizedTokens: chosenTokens,
      savedTokens: Math.max(0, originalTokens - chosenTokens),
      percentSaved: originalTokens
        ? Number((((originalTokens - chosenTokens) / originalTokens) * 100).toFixed(1))
        : 0,
      originalCostUsd: originalCost,
      optimizedCostUsd: optimizedCost,
      savedCostUsd: costSaved,
      pricePerMillionInputTokensUsd: roundMoney(
        route.selectedModel.inputPricePerMillion
      ),
      originalLatencyMs,
      optimizedLatencyMs,
      savedLatencyMs: latencySavedMs,
      speedupPercent
    }
  };
}

// Call OpenAI for the final ranked candidate set.
async function translateWithOpenAI(text, options) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify(buildOpenAIRequest(text, options.route, false))
  });

  if (!response.ok) {
    const details = await safeReadText(response);
    throw new Error(
      `OpenAI request failed with ${response.status}: ${details || "unknown error"}`
    );
  }

  const payload = await response.json();
  return normalizeOpenAITranslation(extractOutputText(payload));
}

// Use lightweight local heuristics when no API key exists.
async function translateWithFallback(text) {
  const english = compressEnglish(text);
  const json = compressAsJson(text);
  const keywords = compressAsKeywordList(text);

  return {
    rationale:
      "Fallback mode compares a few local compact formats only. Add OPENAI_API_KEY for live multilingual comparisons.",
    bestOptionId: "fallback-english",
    estimatedOriginalTokens: estimateTokens(text),
    options: [
      {
        id: "fallback-english",
        label: "Compressed English",
        languageCode: "en-x-fallback",
        kind: "natural-language",
        optimizedText: english,
        rationale: "Local English compression preserves meaning without network access.",
        estimatedTokens: estimateTokens(english)
      },
      {
        id: "fallback-json",
        label: "Compact JSON",
        languageCode: "json",
        kind: "structured",
        optimizedText: json,
        rationale: "Compact JSON can be efficient when the request is mostly constraints.",
        estimatedTokens: estimateTokens(json)
      },
      {
        id: "fallback-keywords",
        label: "Keyword Shorthand",
        languageCode: "kv",
        kind: "structured",
        optimizedText: keywords,
        rationale: "Keyword shorthand is a cheap fallback preview for terse prompts.",
        estimatedTokens: estimateTokens(keywords)
      }
    ],
    mode: "fallback"
  };
}

// Build the model prompt for both streaming and non-streaming calls.
function buildOpenAIRequest(text, route, stream) {
  return {
    model: route.selectedModel.id,
    stream,
    reasoning: {
      effort: route.selectedModel.reasoningEffort
    },
    text: {
      verbosity: "low"
    },
    input: [
      {
        role: "system",
        content: OPENAI_SYSTEM_PROMPT
      },
      {
        role: "system",
        content:
          "Routing metadata is internal only. Do not mention difficulty scores, selected models, or routing decisions inside any optimizedText option unless the source text explicitly asks for them."
      },
      {
        role: "user",
        content: `Source text:\n${text}`
      }
    ]
  };
}

// Add comparable cost fields to each candidate.
function buildCandidateReports(options, originalTokens, model) {
  const normalizedOptions = Array.isArray(options) && options.length
    ? options
    : [
        {
          id: "single",
          label: "Optimized result",
          languageCode: "n/a",
          kind: "natural-language",
          optimizedText: "",
          rationale: "",
          estimatedTokens: originalTokens
        }
      ];

  return normalizedOptions
    .map((option) => {
      const estimatedTokens = normalizeEstimatedTokens(
        option.estimatedTokens,
        estimateTokens(option.optimizedText)
      );
      const estimatedCostUsd = estimateCostUsd(
        estimatedTokens,
        model.inputPricePerMillion
      );
      const savedTokens = Math.max(0, originalTokens - estimatedTokens);
      const savedCostUsd = Math.max(
        0,
        estimateCostUsd(originalTokens, model.inputPricePerMillion) - estimatedCostUsd
      );

      return {
        id: option.id,
        label: option.label,
        languageCode: option.languageCode,
        kind: option.kind,
        optimizedText: option.optimizedText,
        rationale: option.rationale,
        estimatedTokens,
        estimatedCostUsd,
        savedTokens,
        savedCostUsd
      };
    })
    .sort((left, right) => left.estimatedTokens - right.estimatedTokens);
}

// Show what the same prompt would cost on each model.
function buildModelComparison(originalTokens, optimizedTokens) {
  return getModelCatalog().map((model) => {
    const optimizerRunCostUsd =
      estimateCostUsd(originalTokens, model.inputPricePerMillion) +
      estimateCostUsd(optimizedTokens, model.outputPricePerMillion);

    return {
      id: model.id,
      label: model.label,
      tier: model.tier,
      inputPricePerMillion: model.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion,
      optimizerRunCostUsd: roundMoney(optimizerRunCostUsd),
      downstreamOriginalInputUsd: estimateCostUsd(
        originalTokens,
        model.inputPricePerMillion
      ),
      downstreamOptimizedInputUsd: estimateCostUsd(
        optimizedTokens,
        model.inputPricePerMillion
      ),
      downstreamSavedInputUsd: Math.max(
        0,
        estimateCostUsd(originalTokens, model.inputPricePerMillion) -
          estimateCostUsd(optimizedTokens, model.inputPricePerMillion)
      )
    };
  });
}

// Respect the model's preferred winner when possible.
function pickWinningCandidate(candidates, bestOptionId) {
  if (bestOptionId) {
    const explicit = candidates.find((candidate) => candidate.id === bestOptionId);
    if (explicit) {
      return explicit;
    }
  }

  return candidates[0];
}

// Normalize the model JSON into a stable internal format.
function normalizeOpenAITranslation(rawText) {
  const parsed = parseModelJson(rawText);
  const options = Array.isArray(parsed.options) ? parsed.options : [];
  const fallbackOption = options.length
    ? null
    : {
        id: "single",
        label: parsed.language || "Optimized result",
        languageCode: parsed.languageCode || "n/a",
        kind: "natural-language",
        optimizedText: String(parsed.optimizedText || "").trim(),
        rationale: String(parsed.rationale || "").trim(),
        estimatedTokens: normalizeEstimatedTokens(
          parsed.estimatedOptimizedTokens,
          undefined
        )
      };

  return {
    rationale: String(parsed.rationale || "").trim(),
    bestOptionId: parsed.bestOptionId || fallbackOption?.id,
    estimatedOriginalTokens: normalizeEstimatedTokens(
      parsed.estimatedOriginalTokens,
      undefined
    ),
    options: options.length
      ? options.map((option, index) => ({
          id: option.id || `option-${index + 1}`,
          label: option.label || "Candidate",
          languageCode: option.languageCode || "n/a",
          kind: option.kind || "natural-language",
          optimizedText: String(option.optimizedText || "").trim(),
          rationale: String(option.rationale || "").trim(),
          estimatedTokens: normalizeEstimatedTokens(
            option.estimatedTokens,
            undefined
          )
        }))
      : [fallbackOption],
    mode: "openai"
  };
}

// Reject empty inputs early.
function normalizeInputText(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) {
    throw new Error("Text is required.");
  }
  return text;
}

// Allow tests to override env-driven auth.
function resolveApiKey(options) {
  return Object.prototype.hasOwnProperty.call(options, "apiKey")
    ? options.apiKey || ""
    : process.env.OPENAI_API_KEY || "";
}

// Fallback: trim English while keeping the request readable.
function compressEnglish(text) {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  const summary = sentences
    .map((sentence) => {
      const cleaned = sentence.replace(/[^\p{L}\p{N}\s'-]/gu, " ");
      const words = cleaned.split(/\s+/).filter(Boolean);
      const kept = words.filter((word) => !FALLBACK_STOPWORDS.has(word.toLowerCase()));
      return kept.slice(0, 8).join(" ");
    })
    .filter(Boolean)
    .join("; ");

  return summary || text.slice(0, 120);
}

// Fallback: try a compact structured shape.
function compressAsJson(text) {
  const words = text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12);

  return JSON.stringify({ task: words.slice(0, 4).join(" "), constraints: words.slice(4) });
}

// Fallback: squeeze the message into terse keywords.
function compressAsKeywordList(text) {
  return text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 14)
    .join(" | ");
}

// Pull plain text out of a Responses API payload.
function extractOutputText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];

  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

// Accept either clean JSON or wrapped JSON text.
function parseModelJson(rawText) {
  if (!rawText) {
    throw new Error("The model returned an empty response.");
  }

  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("The model response was not valid JSON.");
    }

    return JSON.parse(match[0]);
  }
}

// Approximate token cost from price-per-million.
function estimateCostUsd(tokens, pricePerMillion) {
  return roundMoney((tokens / 1_000_000) * pricePerMillion);
}

// Approximate latency from a simple linear model.
function estimateLatencyMs(tokens, baseLatencyMs, msPerToken) {
  return Math.round(baseLatencyMs + tokens * msPerToken);
}

// Keep money values stable in the UI.
function roundMoney(value) {
  return Number(value.toFixed(6));
}

// Prefer model estimates, then fall back locally.
function normalizeEstimatedTokens(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }

  return fallback;
}

// Best-effort read for failed fetch responses.
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// Parse SSE event blocks from the streaming response.
async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      // SSE messages arrive chunked, so we buffer until we have a full event block.
      const boundary = buffer.indexOf("\n\n");
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());

      if (!dataLines.length) {
        continue;
      }

      const data = dataLines.join("\n");
      if (data === "[DONE]") {
        continue;
      }

      yield JSON.parse(data);
    }
  }
}

// Fake local streaming by slicing the final text.
function chunkText(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += 24) {
    chunks.push(text.slice(index, index + 24));
  }
  return chunks;
}

// Trim the route object down for the client payload.
function serializeRoute(route) {
  return {
    modelMode: route.modelMode,
    promptTokens: route.promptTokens,
    reason: route.reason,
    difficulty: route.difficulty,
    suggestedModel: { ...route.suggestedModel },
    selectedModel: { ...route.selectedModel }
  };
}
