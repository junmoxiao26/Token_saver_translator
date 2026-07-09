export function estimateTokens(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return 0;
  }

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const charCount = [...normalized].length;
  return Math.max(1, Math.round(charCount / 4 + wordCount * 0.2));
}
