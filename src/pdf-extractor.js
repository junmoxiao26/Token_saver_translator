import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON_CANDIDATES = [
  "/Users/xiaochuanbai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
  "python3",
  "python"
];

const EXTRACT_SCRIPT = `
import json
import sys

text = ""
page_count = 0
errors = []

try:
    from pypdf import PdfReader
    reader = PdfReader(sys.argv[1])
    page_count = len(reader.pages)
    parts = []
    for page in reader.pages:
        parts.append((page.extract_text() or "").strip())
    text = "\\n\\n".join([part for part in parts if part])
except Exception as exc:
    errors.append(f"pypdf:{exc}")

if not text:
    try:
        import pdfplumber
        parts = []
        with pdfplumber.open(sys.argv[1]) as pdf:
            page_count = len(pdf.pages)
            for page in pdf.pages:
                parts.append((page.extract_text() or "").strip())
        text = "\\n\\n".join([part for part in parts if part])
    except Exception as exc:
        errors.append(f"pdfplumber:{exc}")

print(json.dumps({
    "text": text,
    "pageCount": page_count,
    "errors": errors
}))
`;

// Write the uploaded PDF to temp storage, then extract plain text.
export async function extractPdfTextFromBase64(base64, fileName = "input.pdf") {
  if (!base64) {
    throw new Error("PDF data is required.");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "token-saver-pdf-"));
  const safeName = sanitizeFileName(fileName || "input.pdf");
  const pdfPath = path.join(tempDir, safeName.endsWith(".pdf") ? safeName : `${safeName}.pdf`);

  try {
    await writeFile(pdfPath, Buffer.from(base64, "base64"));
    const payload = await runExtractor(pdfPath);
    const text = String(payload.text || "").trim();

    if (!text) {
      throw new Error("No extractable text was found in the PDF.");
    }

    return {
      text,
      pageCount: Number(payload.pageCount) || 0,
      fileName: safeName
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// Try the bundled Python first, then common fallbacks.
async function runExtractor(pdfPath) {
  let lastError;

  for (const python of PYTHON_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(python, ["-c", EXTRACT_SCRIPT, pdfPath], {
        maxBuffer: 10 * 1024 * 1024
      });
      return JSON.parse(stdout);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `PDF extraction failed. ${lastError?.message || "No usable Python runtime found."}`
  );
}

// Keep temp filenames filesystem-safe.
function sanitizeFileName(fileName) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}
