import test from "node:test";
import assert from "node:assert/strict";

import { optimizeText } from "../src/optimizer.js";
import { chooseRoute } from "../src/model-router.js";
import { createRequestHandler } from "../src/server.js";

test("serves the main interface", async () => {
  const handler = createRequestHandler();
  const response = await handler({
    method: "GET",
    pathname: "/"
  });
  const html = response.body.toString("utf8");

  assert.equal(response.statusCode, 200);
  assert.match(html, /Token Saver Translator/);
  assert.match(html, /Drop in a PDF/);
  assert.match(html, /Other cheaper-looking options/);
});

test("optimizes text through the api contract", async () => {
  const handler = createRequestHandler({
    optimize: async (_text, options) => ({
      source: {
        kind: "text",
        label: "Pasted prompt"
      },
      sourceText: "Write a concise launch email for our product update.",
      optimizedText: "为产品更新写简洁发布邮件。",
      chosenLanguage: "Mandarin",
      chosenLanguageCode: "zh-CN",
      chosenKind: "natural-language",
      rationale: "Mandarin won on estimated tokens.",
      companionNote:
        "Cute Friendly Codex London note: it really is fun being around London on July 1, 2026.",
      mode: "openai",
      model: options.manualModel || "gpt-5.4-mini",
      route: {
        modelMode: options.modelMode,
        promptTokens: 15,
        reason: "Manual override selected GPT-5.4 Mini.",
        difficulty: {
          score: 31,
          label: "Medium",
          summary: "Some structure or constraint handling needed."
        },
        suggestedModel: {
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini"
        },
        selectedModel: {
          id: options.manualModel || "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
          inputPricePerMillion: 0.75,
          baseLatencyMs: 340,
          msPerToken: 2.2
        }
      },
      candidates: [
        {
          id: "zh",
          label: "Mandarin",
          languageCode: "zh-CN",
          kind: "natural-language",
          optimizedText: "为产品更新写简洁发布邮件。",
          rationale: "Cheapest candidate.",
          estimatedTokens: 8,
          estimatedCostUsd: 0.000006,
          savedTokens: 7,
          savedCostUsd: 0.000005
        },
        {
          id: "json",
          label: "Compact JSON",
          languageCode: "json",
          kind: "structured",
          optimizedText: "{\"task\":\"launch email\",\"tone\":\"concise\"}",
          rationale: "Close second.",
          estimatedTokens: 10,
          estimatedCostUsd: 0.000008,
          savedTokens: 5,
          savedCostUsd: 0.000003
        }
      ],
      modelComparison: [
        {
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
          tier: "mini",
          inputPricePerMillion: 0.75,
          outputPricePerMillion: 4.5,
          optimizerRunCostUsd: 0.00005,
          downstreamOriginalInputUsd: 0.000011,
          downstreamOptimizedInputUsd: 0.000006,
          downstreamSavedInputUsd: 0.000005
        }
      ],
      metrics: {
        originalTokens: 15,
        optimizedTokens: 8,
        savedTokens: 7,
        percentSaved: 46.7,
        originalCostUsd: 0.000011,
        optimizedCostUsd: 0.000006,
        savedCostUsd: 0.000005,
        pricePerMillionInputTokensUsd: 0.75,
        originalLatencyMs: 503,
        optimizedLatencyMs: 478,
        savedLatencyMs: 25,
        speedupPercent: 5
      }
    })
  });

  const response = await handler({
    method: "POST",
    pathname: "/api/optimize",
    body: {
      text: "Write a concise launch email for our product update.",
      modelMode: "manual",
      manualModel: "gpt-5.4-mini"
    }
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.chosenLanguage, "Mandarin");
  assert.equal(payload.candidates[0].label, "Mandarin");
  assert.equal(payload.route.selectedModel.id, "gpt-5.4-mini");
});

test("fallback optimization returns candidate fields", async () => {
  const result = await optimizeText(
    "Write a warm but direct customer follow-up email asking for missing invoice details within 48 hours.",
    { apiKey: "" }
  );

  assert.equal(result.mode, "fallback");
  assert.equal(result.candidates.length, 3);
  assert.equal(typeof result.metrics.savedLatencyMs, "number");
  assert.ok(result.optimizedText.length > 0);
});

test("model routing picks nano for simple prompts and latest for hard prompts", () => {
  const light = chooseRoute("Translate this to the shortest natural language.");
  const hard = chooseRoute(
    "Analyze this API migration plan, preserve every constraint, compare implementation tradeoffs, return JSON, and explain the safest rollout sequence with fallbacks."
  );

  assert.equal(light.selectedModel.id, "gpt-5.4-nano");
  assert.equal(hard.selectedModel.id, "gpt-5.5");
});

test("pdf requests are extracted before optimization", async () => {
  let receivedText = "";

  const handler = createRequestHandler({
    extractPdfText: async () => ({
      text: "Quarterly revenue summary and call to action.",
      pageCount: 3,
      fileName: "brief.pdf"
    }),
    optimize: async (text, options) => {
      receivedText = text;
      return {
        source: options.source,
        sourceText: text,
        optimizedText: "季度营收摘要与行动号召。",
        chosenLanguage: "Mandarin",
        chosenLanguageCode: "zh-CN",
        chosenKind: "natural-language",
        rationale: "PDF text extracted correctly.",
        companionNote:
          "Cute Friendly Codex London note: it really is fun being around London on July 1, 2026.",
        mode: "openai",
        model: "gpt-5.4-mini",
        route: {
          modelMode: "auto",
          promptTokens: 12,
          reason: "Auto route picked the cheapest model that should still handle a light prompt safely.",
          difficulty: {
            score: 22,
            label: "Light",
            summary: "Short prompt with limited ambiguity."
          },
          suggestedModel: {
            id: "gpt-5.4-nano",
            label: "GPT-5.4 Nano"
          },
          selectedModel: {
            id: "gpt-5.4-nano",
            label: "GPT-5.4 Nano",
            inputPricePerMillion: 0.2,
            baseLatencyMs: 260,
            msPerToken: 1.6
          }
        },
        candidates: [],
        modelComparison: [],
        metrics: {
          originalTokens: 12,
          optimizedTokens: 7,
          savedTokens: 5,
          percentSaved: 41.7,
          originalCostUsd: 0.000002,
          optimizedCostUsd: 0.000001,
          savedCostUsd: 0.000001,
          pricePerMillionInputTokensUsd: 0.2,
          originalLatencyMs: 280,
          optimizedLatencyMs: 271,
          savedLatencyMs: 9,
          speedupPercent: 3.2
        }
      };
    }
  });

  const response = await handler({
    method: "POST",
    pathname: "/api/optimize",
    body: {
      text: "",
      pdfBase64: "ZmFrZQ==",
      fileName: "brief.pdf",
      modelMode: "auto"
    }
  });
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.match(receivedText, /Quarterly revenue summary/);
  assert.equal(payload.source.kind, "pdf");
  assert.equal(payload.source.fileName, "brief.pdf");
});
