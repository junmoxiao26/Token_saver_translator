import { estimateTokens } from "./token-estimator.js";

const MODEL_CATALOG = [
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    tier: "nano",
    inputPricePerMillion: 0.2,
    outputPricePerMillion: 1.25,
    baseLatencyMs: 260,
    msPerToken: 1.6,
    maxDifficulty: 25,
    reasoningEffort: "none",
    description: "Cheapest route for short, literal, low-ambiguity prompts."
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    tier: "mini",
    inputPricePerMillion: 0.75,
    outputPricePerMillion: 4.5,
    baseLatencyMs: 340,
    msPerToken: 2.2,
    maxDifficulty: 55,
    reasoningEffort: "low",
    description: "Budget-friendly default for light rewriting and structured instructions."
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    tier: "standard",
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 15,
    baseLatencyMs: 460,
    msPerToken: 3,
    maxDifficulty: 82,
    reasoningEffort: "low",
    description: "Balanced option for denser prompts with multiple constraints."
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    tier: "latest",
    inputPricePerMillion: 5,
    outputPricePerMillion: 30,
    baseLatencyMs: 620,
    msPerToken: 3.8,
    maxDifficulty: 100,
    reasoningEffort: "medium",
    description: "Latest flagship choice for the hardest multi-constraint prompt rewrites."
  }
];

const COMPLEXITY_PATTERNS = [
  { pattern: /```|function |class |SELECT |INSERT |UPDATE |console\.|stack trace|regex/gi, weight: 18 },
  { pattern: /\b(api|sdk|architecture|schema|migration|stream|tool|agent|workflow)\b/gi, weight: 12 },
  { pattern: /\b(compare|analyze|evaluate|critique|reason|debug|optimize|plan)\b/gi, weight: 10 },
  { pattern: /\bjson|csv|table|bullet|format|schema|markdown|yaml|xml\b/gi, weight: 8 },
  { pattern: /\bmust|should|need to|include|avoid|exactly|strict|preserve\b/gi, weight: 5 },
  { pattern: /\btranslate|rewrite|summarize|email|caption|tagline|bio\b/gi, weight: 2 }
];

const STEP_PATTERNS = /\b(first|then|after|before|step|1\.|2\.|3\.|finally)\b/gi;
const HARD_TASK_PATTERNS =
  /\b(api|migration|tradeoff|tradeoffs|fallback|fallbacks|preserve|constraint|constraints|safest|json)\b/gi;

// Return a copy so callers cannot mutate the source catalog.
export function getModelCatalog() {
  return MODEL_CATALOG.map((model) => ({ ...model }));
}

// Pick the cheapest model likely to handle the prompt safely.
export function chooseRoute(text, options = {}) {
  const promptTokens = estimateTokens(text);
  const difficulty = scoreDifficulty(text, promptTokens);
  const suggestedModel = pickSuggestedModel(difficulty.score);
  const selectedModel = resolveSelectedModel(
    options.modelMode,
    options.manualModel,
    suggestedModel.id
  );

  return {
    modelMode: options.modelMode || "auto",
    promptTokens,
    difficulty,
    suggestedModel,
    selectedModel,
    reason:
      options.modelMode && options.modelMode !== "auto"
        ? `Manual override selected ${selectedModel.label}.`
        : `Auto route picked the cheapest model that should still handle a ${difficulty.label.toLowerCase()} prompt safely.`
  };
}

// Turn prompt features into a rough difficulty score.
export function scoreDifficulty(text, promptTokens = estimateTokens(text)) {
  const trimmed = String(text || "").trim();
  const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
  const sentenceCount = trimmed
    ? trimmed.split(/(?<=[.!?])\s+/).filter(Boolean).length
    : 0;
  const constraintCount = countMatches(trimmed, /\b(and|with|without|while|within|under|between|except)\b/gi);
  const stepCount = countMatches(trimmed, STEP_PATTERNS);
  const punctuationWeight = countMatches(trimmed, /[:,;()[\]{}]/g);
  const hardTaskCount = countMatches(trimmed, HARD_TASK_PATTERNS);

  let score = Math.min(24, Math.round(promptTokens * 0.55));
  score += Math.min(10, Math.round(wordCount / 18));
  score += Math.min(12, constraintCount * 2);
  score += Math.min(8, sentenceCount * 2);
  score += Math.min(10, stepCount * 3);
  score += Math.min(6, punctuationWeight);
  score += Math.min(20, hardTaskCount * 2);

  const signals = [];
  for (const entry of COMPLEXITY_PATTERNS) {
    const matches = countMatches(trimmed, entry.pattern);
    if (matches > 0) {
      score += Math.min(entry.weight, matches * Math.max(2, Math.round(entry.weight / 3)));
      signals.push(matches);
    }
  }

  if (wordCount <= 12 && sentenceCount <= 1 && constraintCount <= 1) {
    score -= 8;
  }

  if (hardTaskCount >= 5 && promptTokens >= 30) {
    score += 18;
  }

  score = Math.max(1, Math.min(100, score));

  let label = "Light";
  if (score > 75) {
    label = "Hard";
  } else if (score > 45) {
    label = "Medium";
  }

  return {
    score,
    label,
    summary:
      label === "Light"
        ? "Short prompt with limited ambiguity."
        : label === "Medium"
          ? "Some structure or constraint handling needed."
          : "Dense prompt with multiple constraints or technical intent."
  };
}

// Choose the first model tier that fits the score.
function pickSuggestedModel(score) {
  return MODEL_CATALOG.find((model) => score <= model.maxDifficulty) || MODEL_CATALOG[MODEL_CATALOG.length - 1];
}

// Respect a manual override when the UI sends one.
function resolveSelectedModel(modelMode, manualModel, fallbackId) {
  if (modelMode === "manual" && manualModel) {
    return MODEL_CATALOG.find((model) => model.id === manualModel) || pickById(fallbackId);
  }

  return pickById(fallbackId);
}

// Find a model by id with a safe fallback.
function pickById(modelId) {
  return MODEL_CATALOG.find((model) => model.id === modelId) || MODEL_CATALOG[0];
}

// Count regex hits without leaking null checks everywhere.
function countMatches(text, pattern) {
  if (!text) {
    return 0;
  }

  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}
