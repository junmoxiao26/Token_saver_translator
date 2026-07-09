const elements = {
  body: document.body,
  sourceText: document.querySelector("#sourceText"),
  pdfInput: document.querySelector("#pdfInput"),
  sourceBadge: document.querySelector("#sourceBadge"),
  modelMode: document.querySelector("#modelMode"),
  submitButton: document.querySelector("#submitButton"),
  copyButton: document.querySelector("#copyButton"),
  statusLine: document.querySelector("#statusLine"),
  companionNote: document.querySelector("#companionNote"),
  resultText: document.querySelector("#resultText"),
  rationaleText: document.querySelector("#rationaleText"),
  routeText: document.querySelector("#routeText"),
  modeValue: document.querySelector("#modeValue"),
  difficultyValue: document.querySelector("#difficultyValue"),
  selectedModelValue: document.querySelector("#selectedModelValue"),
  suggestedModelValue: document.querySelector("#suggestedModelValue"),
  languageValue: document.querySelector("#languageValue"),
  tokensSavedValue: document.querySelector("#tokensSavedValue"),
  costSavedValue: document.querySelector("#costSavedValue"),
  speedSavedValue: document.querySelector("#speedSavedValue"),
  originalTokensValue: document.querySelector("#originalTokensValue"),
  optimizedTokensValue: document.querySelector("#optimizedTokensValue"),
  originalCostValue: document.querySelector("#originalCostValue"),
  optimizedCostValue: document.querySelector("#optimizedCostValue"),
  originalLatencyValue: document.querySelector("#originalLatencyValue"),
  optimizedLatencyValue: document.querySelector("#optimizedLatencyValue"),
  historyList: document.querySelector("#historyList"),
  candidateList: document.querySelector("#candidateList"),
  modelGrid: document.querySelector("#modelGrid")
};

const state = {
  history: [],
  models: [],
  selectedFile: null,
  rawStreamBuffer: ""
};

// Wire up the main UI events.
elements.submitButton.addEventListener("click", submitPrompt);
elements.copyButton.addEventListener("click", copyResult);
elements.pdfInput.addEventListener("change", onFileSelected);
elements.sourceText.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    submitPrompt();
  }
});

// Load model choices for the route selector.
bootstrap();

async function bootstrap() {
  try {
    const response = await fetch("/api/models");
    const payload = await response.json();
    state.models = Array.isArray(payload.models) ? payload.models : [];
    hydrateModelSelector();
    renderModelComparison([]);
  } catch {
    setStatus("Model catalog could not be loaded. Auto mode will still work.");
  }
}

// Mirror the selected PDF in the small status badge.
function onFileSelected() {
  state.selectedFile = elements.pdfInput.files[0] || null;
  if (state.selectedFile) {
    elements.sourceBadge.textContent = `PDF ready: ${state.selectedFile.name}`;
    elements.sourceBadge.classList.add("has-file");
  } else {
    elements.sourceBadge.textContent = "Using pasted text only";
    elements.sourceBadge.classList.remove("has-file");
  }
}

// Send the current text/PDF input to the streaming endpoint.
async function submitPrompt() {
  const text = elements.sourceText.value.trim();
  if (!text && !state.selectedFile) {
    setStatus("Paste a prompt or upload a PDF first.");
    elements.sourceText.focus();
    return;
  }

  setBusy(true);
  setStatus("Streaming optimization...");
  prepareStreamingView();

  try {
    const response = await fetch("/api/optimize/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(await buildRequestBody(text))
    });

    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Optimization failed.");
    }

    await consumeEventStream(response);
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  } finally {
    setBusy(false);
  }
}

// Copy only the winning prompt text.
async function copyResult() {
  const text = elements.resultText.textContent.trim();
  if (!text || elements.resultText.classList.contains("empty")) {
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Optimized prompt copied.");
  } catch {
    setStatus("Copy failed. Your browser blocked clipboard access.");
  }
}

// Paint the final winning result into the dashboard.
function renderResult(payload) {
  const metrics = payload.metrics;
  const route = payload.route;

  elements.body.classList.add("is-success");
  elements.resultText.classList.remove("empty");
  elements.resultText.textContent = payload.optimizedText;
  elements.rationaleText.textContent = payload.rationale;
  elements.routeText.textContent = route.reason;
  elements.companionNote.textContent = payload.companionNote;
  elements.copyButton.disabled = false;

  elements.modeValue.textContent =
    payload.mode === "openai" ? "Live OpenAI" : "Fallback preview";
  elements.difficultyValue.textContent = `${route.difficulty.score} / 100`;
  elements.selectedModelValue.textContent = route.selectedModel.label;
  elements.suggestedModelValue.textContent = route.suggestedModel.label;
  elements.languageValue.textContent = `${payload.chosenLanguage} (${payload.chosenKind})`;
  elements.tokensSavedValue.textContent = formatNumber(metrics.savedTokens);
  elements.costSavedValue.textContent = formatCurrency(metrics.savedCostUsd);
  elements.speedSavedValue.textContent = `${formatNumber(metrics.savedLatencyMs)} ms`;

  elements.originalTokensValue.textContent = formatNumber(metrics.originalTokens);
  elements.optimizedTokensValue.textContent = formatNumber(metrics.optimizedTokens);
  elements.originalCostValue.textContent = formatCurrency(metrics.originalCostUsd);
  elements.optimizedCostValue.textContent = formatCurrency(metrics.optimizedCostUsd);
  elements.originalLatencyValue.textContent = `${formatNumber(metrics.originalLatencyMs)} ms`;
  elements.optimizedLatencyValue.textContent = `${formatNumber(metrics.optimizedLatencyMs)} ms`;

  renderCandidates(payload.candidates || []);
  renderModelComparison(payload.modelComparison || []);

  state.history.unshift({
    source: payload.source,
    sourceText: payload.sourceText,
    optimizedText: payload.optimizedText,
    route,
    metrics,
    chosenLanguage: payload.chosenLanguage
  });
  renderHistory();
}

// Render the ranked candidate alternatives.
function renderCandidates(candidates) {
  if (!candidates.length) {
    elements.candidateList.innerHTML =
      '<div class="history-empty">Candidate languages and structured formats will appear here.</div>';
    return;
  }

  elements.candidateList.innerHTML = candidates
    .map((candidate, index) => {
      return `
        <article class="candidate-card ${index === 0 ? "is-winner" : ""}">
          <div class="candidate-top">
            <strong>${escapeHtml(candidate.label)}</strong>
            <span>${escapeHtml(candidate.kind)}</span>
          </div>
          <p class="candidate-copy">${escapeHtml(candidate.optimizedText)}</p>
          <p class="candidate-rationale">${escapeHtml(candidate.rationale)}</p>
          <div class="candidate-stats">
            <span>${formatNumber(candidate.estimatedTokens)} tokens</span>
            <span>${formatCurrency(candidate.estimatedCostUsd)}</span>
            <span>Save ${formatNumber(candidate.savedTokens)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

// Render the per-model cost comparison cards.
function renderModelComparison(models) {
  const rows = models.length ? models : state.models;
  if (!rows.length) {
    elements.modelGrid.innerHTML =
      '<div class="history-empty">Per-model cost comparisons will appear here for each run.</div>';
    return;
  }

  elements.modelGrid.innerHTML = rows
    .map((model) => {
      const runCost = model.optimizerRunCostUsd ?? 0;
      const saved = model.downstreamSavedInputUsd ?? 0;
      return `
        <article class="model-card">
          <div class="candidate-top">
            <strong>${escapeHtml(model.label)}</strong>
            <span>${escapeHtml(model.tier || "model")}</span>
          </div>
          <p class="model-pricing">Input: ${formatMoneyNumber(model.inputPricePerMillion)} / 1M • Output: ${formatMoneyNumber(model.outputPricePerMillion)} / 1M</p>
          <div class="model-costs">
            <span>Optimizer run: ${formatCurrency(runCost)}</span>
            <span>Next prompt saved: ${formatCurrency(saved)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

// Keep a simple in-memory session history.
function renderHistory() {
  if (!state.history.length) {
    elements.historyList.innerHTML =
      '<div class="history-empty">Each prompt run will be pinned here with its route, model, source type, and savings.</div>';
    return;
  }

  elements.historyList.innerHTML = state.history
    .map((entry) => {
      return `
        <article class="history-card">
          <div class="history-top">
            <strong>${escapeHtml(entry.route.selectedModel.label)}</strong>
            <span>${escapeHtml(entry.chosenLanguage)}</span>
          </div>
          <p class="history-source">${escapeHtml(entry.source.label || "Prompt")}</p>
          <p class="history-source">${escapeHtml(entry.sourceText.slice(0, 180))}${entry.sourceText.length > 180 ? "..." : ""}</p>
          <p class="history-output">${escapeHtml(entry.optimizedText)}</p>
          <div class="history-stats">
            <span>${escapeHtml(entry.source.kind)}</span>
            <span>Difficulty ${entry.route.difficulty.score}/100</span>
            <span>${formatCurrency(entry.metrics.savedCostUsd)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

// Toggle the busy button state.
function setBusy(isBusy) {
  elements.body.classList.toggle("is-busy", isBusy);
  elements.submitButton.disabled = isBusy;
  elements.submitButton.textContent = isBusy ? "Optimizing..." : "Optimize";
}

// Update the small live status line.
function setStatus(message) {
  elements.statusLine.textContent = message;
}

// Fill the route selector with auto + manual choices.
function hydrateModelSelector() {
  const options = [
    { value: "auto", label: "Auto cheapest safe route" },
    ...state.models.map((model) => ({
      value: `manual:${model.id}`,
      label: `${model.label} (${model.description})`
    }))
  ];

  elements.modelMode.innerHTML = options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    )
    .join("");
}

// Build the request payload the server expects.
async function buildRequestBody(text) {
  const value = elements.modelMode.value;
  const payload = {
    text
  };

  if (value.startsWith("manual:")) {
    payload.modelMode = "manual";
    payload.manualModel = value.slice("manual:".length);
  } else {
    payload.modelMode = "auto";
  }

  if (state.selectedFile) {
    payload.fileName = state.selectedFile.name;
    payload.pdfBase64 = await readFileAsBase64(state.selectedFile);
  }

  return payload;
}

// Read the streaming HTTP body into SSE event blocks.
async function consumeEventStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  state.rawStreamBuffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const boundary = buffer.indexOf("\n\n");
      const eventBlock = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseEventBlock(eventBlock);
      if (!parsed) {
        continue;
      }

      handleStreamEvent(parsed);
    }
  }
}

// Turn one raw SSE block into a typed event.
function parseEventBlock(eventBlock) {
  const lines = eventBlock.split("\n");
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
  const dataText = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!eventName || !dataText) {
    return null;
  }

  return {
    name: eventName,
    payload: JSON.parse(dataText)
  };
}

// Update the UI as each stream event arrives.
function handleStreamEvent(event) {
  if (event.name === "meta") {
    const route = event.payload.route;
    elements.modeValue.textContent = "Streaming live";
    elements.difficultyValue.textContent = `${route.difficulty.score} / 100`;
    elements.selectedModelValue.textContent = route.selectedModel.label;
    elements.suggestedModelValue.textContent = route.suggestedModel.label;
    elements.routeText.textContent = route.reason;
    elements.companionNote.textContent = event.payload.companionNote;
    setStatus(`Comparing Mandarin, Japanese, JSON, and more with ${route.selectedModel.label}...`);
    return;
  }

  if (event.name === "delta") {
    state.rawStreamBuffer += event.payload.text;
    // The model streams raw JSON first, so show lightweight progress text until the final parsed payload arrives.
    const pulseWords = ["Comparing candidates", "Pricing options", "Checking structured formats", "Picking the cheapest faithful prompt"];
    const step = Math.min(
      pulseWords.length - 1,
      Math.floor(state.rawStreamBuffer.length / 120)
    );
    elements.resultText.classList.remove("empty");
    elements.resultText.textContent = `${pulseWords[step]}...`;
    return;
  }

  if (event.name === "final") {
    renderResult(event.payload.result);
    const payload = event.payload.result;
    const modeNote =
      payload.mode === "openai"
        ? `Live OpenAI stream complete using ${payload.model}.`
        : "Fallback preview stream complete. Add OPENAI_API_KEY for real multilingual optimization.";
    setStatus(modeNote);
    return;
  }

  if (event.name === "error") {
    throw new Error(event.payload.message || "Streaming failed.");
  }
}

// Reset the result area before a new run starts.
function prepareStreamingView() {
  elements.copyButton.disabled = true;
  elements.resultText.classList.remove("empty");
  elements.resultText.textContent = "Preparing candidate comparisons...";
  elements.rationaleText.textContent = "Comparing languages and structured formats in flight...";
  elements.routeText.textContent = "Routing the prompt to the cheapest safe model...";
  elements.candidateList.innerHTML =
    '<div class="history-empty">Live comparison is running. Candidate cards will appear when the model finishes ranking them.</div>';
}

// Format USD figures for the UI.
function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6
  }).format(value || 0);
}

// Format plain counts for the UI.
function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

// Format model price labels with fewer decimals.
function formatMoneyNumber(value) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3
  }).format(value || 0);
}

// Escape HTML before writing template strings.
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Convert the uploaded PDF file to base64 for the JSON API.
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const commaIndex = dataUrl.indexOf(",");
      resolve(commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(new Error("Could not read the PDF file."));
    reader.readAsDataURL(file);
  });
}
