import { createServer as createNodeServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "./env.js";
import { extractPdfTextFromBase64 } from "./pdf-extractor.js";
import {
  getOptimizerCatalog,
  optimizeText,
  streamOptimizeText
} from "./optimizer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

// Build the HTTP app with injectable helpers for tests.
export function createApp(options = {}) {
  const appOptions = buildOptions(options);
  const handler = createRequestHandler(appOptions);

  return createNodeServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const requestUrl = new URL(req.url || "/", "http://localhost");
      if (method === "POST" && requestUrl.pathname === "/api/optimize/stream") {
        const body = await readJson(req);
        return await streamOptimization(res, body, appOptions);
      }
      const body = method === "POST" ? await readJson(req) : undefined;
      const response = await handler({
        method,
        pathname: requestUrl.pathname,
        body
      });
      sendResponse(res, response);
    } catch (error) {
      const status = error.statusCode || 500;
      sendJson(res, status, {
        error: error.message || "Unexpected server error."
      });
    }
  });
}

// Handle non-streaming routes in a testable way.
export function createRequestHandler(options = {}) {
  const appOptions = buildOptions(options);

  return async function handleRequest(request) {
    const method = request.method || "GET";
    const pathname = request.pathname || "/";

    if (method === "GET" && pathname === "/health") {
      return jsonResponse(200, { ok: true });
    }

    if (method === "GET" && pathname === "/api/models") {
      return jsonResponse(200, { models: getOptimizerCatalog() });
    }

    if (method === "POST" && pathname === "/api/optimize") {
      const source = await resolveSource(request.body, appOptions);

      const result = await appOptions.optimize(source.text, {
        apiKey: appOptions.apiKey,
        model: appOptions.model,
        modelMode: request.body?.modelMode,
        manualModel: request.body?.manualModel,
        source: source.meta
      });
      return jsonResponse(200, result);
    }

    if (method === "GET") {
      return readStaticFile(appOptions.publicDir, pathname);
    }

    return jsonResponse(405, { error: "Method not allowed." });
  };
}

// Serve files from the public directory.
async function readStaticFile(rootDir, requestPath) {
  const safePath = sanitizePath(requestPath);
  const filePath = path.join(rootDir, safePath === "/" ? "index.html" : safePath);
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "text/plain; charset=utf-8";

  try {
    const file = await readFile(filePath);
    return {
      statusCode: 200,
      headers: { "Content-Type": contentType },
      body: file
    };
  } catch {
    return jsonResponse(404, { error: "Not found." });
  }
}

// Strip traversal prefixes before reading a file.
function sanitizePath(requestPath) {
  if (requestPath === "/") {
    return "/";
  }

  const normalized = path
    .normalize(requestPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");

  return normalized || "/";
}

// Send a JSON response with shared headers.
function sendJson(res, statusCode, payload) {
  sendResponse(res, jsonResponse(statusCode, payload));
}

// Flush the prepared response object to the socket.
function sendResponse(res, response) {
  res.writeHead(response.statusCode, response.headers);
  res.end(response.body);
}

// Shape a plain JSON payload into a response object.
function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

// Read a small JSON body into memory.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    const maxBodySize = 20_000_000;

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBodySize) {
        reject(withStatus(new Error("Request body is too large."), 413));
      }
    });

    req.on("end", () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed);
      } catch {
        reject(withStatus(new Error("Invalid JSON request body."), 400));
      }
    });

    req.on("error", () => {
      reject(withStatus(new Error("Unable to read request body."), 400));
    });
  });
}

// Attach an HTTP status to a thrown error.
function withStatus(error, statusCode) {
  error.statusCode = statusCode;
  return error;
}

// Fill in the default runtime helpers.
function buildOptions(options = {}) {
  return {
    apiKey: options.apiKey || process.env.OPENAI_API_KEY || "",
    extractPdfText: options.extractPdfText || extractPdfTextFromBase64,
    publicDir: options.publicDir || publicDir,
    optimize: options.optimize || optimizeText,
    model: options.model || process.env.OPENAI_MODEL || "gpt-5.5"
  };
}

// Stream optimization events to the browser as SSE.
async function streamOptimization(res, body, appOptions) {
  // Keep the connection open so the UI can render progress before the final ranked result lands.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  try {
    const source = await resolveSource(body, appOptions);
    for await (const event of streamOptimizeText(source.text, {
      apiKey: appOptions.apiKey,
      model: appOptions.model,
      modelMode: body?.modelMode,
      manualModel: body?.manualModel,
      source: source.meta
    })) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (error) {
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({
        message: error.message || "Streaming failed."
      })}\n\n`
    );
  } finally {
    res.end();
  }
}

// Resolve either pasted text, a PDF, or both into one input string.
async function resolveSource(body, appOptions) {
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const pdfBase64 = typeof body?.pdfBase64 === "string" ? body.pdfBase64.trim() : "";

  if (!text && !pdfBase64) {
    throw withStatus(new Error("Provide prompt text or a PDF."), 400);
  }

  if (!pdfBase64) {
    return {
      text,
      meta: {
        kind: "text",
        label: "Pasted prompt"
      }
    };
  }

  const extracted = await appOptions.extractPdfText(pdfBase64, body?.fileName);
  // If the user typed instructions as well, prepend them so the optimizer treats the PDF as context.
  const combinedText = text
    ? `${text}\n\nPDF content:\n${extracted.text}`
    : extracted.text;

  return {
    text: combinedText,
    meta: {
      kind: text ? "pdf+prompt" : "pdf",
      label: extracted.fileName,
      fileName: extracted.fileName,
      pageCount: extracted.pageCount,
      extractedChars: extracted.text.length
    }
  };
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.listen(port, () => {
    console.log(`Token Saver Translator running at http://localhost:${port}`);
  });
}
