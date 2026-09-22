import "./styles.css";
import { loadAgent } from "./vendor/laya-web/index.ts";
import type { LoadedAgent, LoadProgress } from "./vendor/laya-web/index.ts";

type Mode = "laya" | "api" | "offline";

type CVNSSApi = {
  VERSION: string;
  fromCqn(input: string): { cqn: string; cvn: string; cvss: string };
  fromCvss(input: string): { cqn: string; cvn: string; cvss: string };
  selfTest(): { ok: boolean; tests: number; failures: unknown[] };
};

declare global {
  interface Window {
    CVNSSConverter?: CVNSSApi;
    __bilatiny?: Record<string, unknown>;
  }
}

const CVN = window.CVNSSConverter;
if (!CVN) throw new Error("CVNSSConverter not loaded");

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const DEFAULTS = Object.freeze({
  apiUrl: "https://openrouter.ai/api/v1/chat/completions",
  deepseekModel: "deepseek/deepseek-v4-pro-0813",
  layaModelUrl: "https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/",
  timeoutMs: 90_000,
  maxTokens: 4096,
});

const ROUTER_QUESTIONS = {
  difficulty: {
    type: "score" as const,
    instructions: "How hard is `request` for a language model?",
    criteria: [
      "trivial: a lookup or one-liner",
      "easy: short answer, no reasoning",
      "moderate: several steps",
      "hard: long multi-step reasoning or specialist knowledge",
    ],
  },
  domain: {
    type: "choice" as const,
    instructions: "What domain does `request` belong to?",
    criteria: {
      code: "software engineering, programming, refactoring, architecture, debugging",
      math_or_logic: "mathematics, logic puzzles, proofs, complex calculation",
      writing: "creative writing, essays, emails, blog posts, copywriting",
      factual_lookup: "facts, definitions, trivia, history",
      data_analysis: "statistics, SQL, data manipulation, metrics",
      chitchat: "casual conversation, greetings, small talk",
    },
  },
  needs_tools: {
    type: "noul" as const,
    instructions: "Does answering `request` require external tools, search or private data?",
  },
  is_sensitive: {
    type: "noul" as const,
    instructions: "Does `request` involve money, legal, medical or safety consequences?",
  },
};

const SYSTEM_PROMPT = [
  "Bạn là BILAtiny, trợ lý tiếng Việt.",
  "Mỗi yêu cầu có bản Unicode tiếng Việt và một biểu diễn CVNSS4.0 phụ trợ.",
  "Dùng CVNSS4.0 như working representation để hỗ trợ xử lý tiếng Việt, nhưng không tuyên bố nó là hidden chain-of-thought bắt buộc của mô hình.",
  "Không xuất chain-of-thought, reasoning_content hay suy luận nội bộ.",
  "Chỉ trả lời cuối cùng hữu ích bằng tiếng Việt Unicode chuẩn NFC, trừ khi người dùng yêu cầu rõ ràng CVNSS4.0.",
  "Khi trả code, giữ nguyên cú pháp code; phần giải thích bằng tiếng Việt Unicode.",
].join("\n");

function restoredMode(): Mode {
  const saved = sessionStorage.getItem("bilatiny.mode");
  if (saved === "api" || saved === "offline" || saved === "laya") return saved;
  // Migration from the previous prototype where "auto" meant "use the decision layer".
  if (saved === "auto") return "laya";
  return "laya";
}

const state = {
  mode: restoredMode(),
  apiKey: sessionStorage.getItem("bilatiny.openrouterKey") ?? "",
  apiUrl: sessionStorage.getItem("bilatiny.apiUrl") ?? DEFAULTS.apiUrl,
  deepseekModel: sessionStorage.getItem("bilatiny.deepseekModel") ?? DEFAULTS.deepseekModel,
  layaModelUrl: sessionStorage.getItem("bilatiny.layaModelUrl") ?? DEFAULTS.layaModelUrl,
  showTechnical: sessionStorage.getItem("bilatiny.showTechnical") === "1",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
  busy: false,
};

let layaLoaded: LoadedAgent | null = null;
let layaLoadPromise: Promise<LoadedAgent> | null = null;
let layaLoadedFrom = "";

const chatEl = $<HTMLElement>("chat");
const emptyEl = $<HTMLElement>("empty");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("sendBtn");
const modeBtn = $<HTMLButtonElement>("modeBtn");
const modeLabel = $<HTMLElement>("modeLabel");
const settingsDialog = $<HTMLDialogElement>("settingsDialog");
const template = $<HTMLTemplateElement>("messageTemplate");
const loadProgress = $<HTMLElement>("loadProgress");
const progressBar = $<HTMLElement>("progressBar");
const progressText = $<HTMLElement>("progressText");

function nfc(value: unknown): string {
  return String(value ?? "").normalize("NFC");
}

function encodeCVNSS(text: string): string {
  return CVN.fromCqn(nfc(text)).cvss;
}

function decodeCVNSS(text: string): string {
  return CVN.fromCvss(String(text ?? "")).cqn.normalize("NFC");
}

function setStatus(id: string, value: string): void {
  $(id).textContent = value;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return (bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1) + " MB";
}

function updateLoadProgress(p: LoadProgress): void {
  loadProgress.hidden = false;
  const total = p.total ?? 0;
  const pct = total > 0 ? Math.min(100, (p.received / total) * 100) : 0;
  progressBar.style.width = total > 0 ? pct.toFixed(1) + "%" : "18%";
  progressText.textContent = total > 0
    ? `Đang tải Laya: ${formatBytes(p.received)} / ${formatBytes(total)} (${pct.toFixed(0)}%)`
    : `Đang tải Laya: ${formatBytes(p.received)}`;
  setStatus("layaStatus", total > 0 ? `Laya: tải ${pct.toFixed(0)}%` : "Laya: đang tải");
}

async function ensureLaya(): Promise<LoadedAgent> {
  if (layaLoaded && layaLoadedFrom === state.layaModelUrl) return layaLoaded;
  if (layaLoadPromise && layaLoadedFrom === state.layaModelUrl) return layaLoadPromise;

  layaLoaded = null;
  layaLoadedFrom = state.layaModelUrl;
  setStatus("layaStatus", "Laya: khởi tạo ONNX");
  setStatus("providerStatus", "Runtime: probing WebGPU/WASM");
  loadProgress.hidden = false;

  const wasmPaths = new URL("./ort/", document.baseURI).href;
  layaLoadPromise = loadAgent(state.layaModelUrl, {
    providers: ["webgpu", "wasm"],
    wasmPaths,
    cacheName: "bilatiny-laya-models-v1",
    onProgress: updateLoadProgress,
    batchSize: 8,
  })
    .then((loaded) => {
      layaLoaded = loaded;
      setStatus("layaStatus", "Laya: ready · multilingual ONNX");
      setStatus("providerStatus", "Runtime: " + loaded.provider.toUpperCase());
      progressBar.style.width = "100%";
      progressText.textContent = "Laya đã sẵn sàng";
      window.setTimeout(() => { loadProgress.hidden = true; }, 1100);
      return loaded;
    })
    .catch((error: unknown) => {
      layaLoaded = null;
      setStatus("layaStatus", "Laya: lỗi → local fallback");
      setStatus("providerStatus", "Runtime: fallback");
      loadProgress.hidden = true;
      throw error;
    })
    .finally(() => {
      layaLoadPromise = null;
    });

  return layaLoadPromise;
}

function localDecision(text: string, why = "Laya web unavailable") {
  const s = nfc(text).toLowerCase();
  const codeTerms = ["code", "python", "javascript", "typescript", "rust", "api", "github", "bug", "debug", "lỗi", "kiến trúc", "refactor"];
  const deepTerms = ["phân tích", "so sánh", "thiết kế", "tối ưu", "chiến lược", "vì sao", "kế hoạch", "đánh giá", "mô hình"];
  let mode: "fast" | "think" | "code" = "fast";
  let domain = "general";
  if (codeTerms.some((term) => s.includes(term))) {
    mode = "code";
    domain = "code";
  } else if (s.length > 900 || deepTerms.some((term) => s.includes(term))) {
    mode = "think";
    domain = "reasoning";
  }
  return {
    mode,
    domain,
    difficulty: mode === "fast" ? 0.7 : 2.2,
    needs_tools: 0,
    is_sensitive: 0,
    confidence: 0,
    thinking: mode !== "fast",
    source: "local-fallback",
    reason: why,
  };
}

async function webLayaDecision(unicode: string) {
  try {
    const loaded = await ensureLaya();
    const started = performance.now();
    const result = await loaded.agent.predict(
      { request: unicode, language: "vi" },
      ROUTER_QUESTIONS,
    );

    const answers = result.answers as Record<string, any>;
    const difficulty = Number(answers.difficulty?.score ?? 3);
    const domain = String(answers.domain?.choice ?? "factual_lookup");
    const needsTools = Number(answers.needs_tools?.noul ?? 0);
    const isSensitive = Number(answers.is_sensitive?.noul ?? 0);
    const difficultyConfidence = Number(answers.difficulty?.confidence ?? 0);
    const domainConfidence = Number(answers.domain?.confidence ?? 0);
    const confidence = Math.min(difficultyConfidence, domainConfidence);

    let mode: "fast" | "think" | "code";
    if (domain === "code") mode = "code";
    else if (difficulty >= 1.6 || needsTools >= 0.5 || isSensitive >= 0.35) mode = "think";
    else mode = "fast";
    if (confidence < 0.78 && mode === "fast") mode = "think";

    return {
      mode,
      domain,
      difficulty: Number(difficulty.toFixed(4)),
      needs_tools: Number(needsTools.toFixed(4)),
      is_sensitive: Number(isSensitive.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      thinking: mode !== "fast",
      source: "laya-web",
      provider: loaded.provider,
      latency_ms: Number((performance.now() - started).toFixed(1)),
      usage: result.usage,
    };
  } catch (error) {
    return localDecision(unicode, String((error as Error)?.message ?? error));
  }
}

function setMode(mode: Mode): void {
  state.mode = mode;
  sessionStorage.setItem("bilatiny.mode", mode);
  modeBtn.className = "btn " + (
    mode === "laya" ? "mode-laya" :
    mode === "api" ? "mode-api" :
    "mode-offline"
  );
  modeLabel.textContent =
    mode === "laya" ? "Laya Web" :
    mode === "api" ? "API direct" :
    "Offline";
  modeBtn.title =
    mode === "laya" ? "Laya ONNX trong browser → DeepSeek" :
    mode === "api" ? "Bỏ qua Laya, gọi DeepSeek trực tiếp" :
    "Không gọi model; chỉ chạy CVNSS converter";
}

function cycleMode(): void {
  setMode(state.mode === "laya" ? "api" : state.mode === "api" ? "offline" : "laya");
}

function removeEmpty(): void {
  if (emptyEl.isConnected) emptyEl.remove();
}

function addMessage(role: "user" | "assistant" | "system", text: string, technical?: unknown) {
  removeEmpty();
  const node = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.classList.add(role);
  node.querySelector<HTMLElement>(".message-head")!.textContent =
    role === "user" ? "Bạn" : role === "assistant" ? "BILAtiny" : "Hệ thống";
  node.querySelector<HTMLElement>(".answer")!.textContent = nfc(text);

  const trace = node.querySelector<HTMLDetailsElement>(".trace")!;
  if (technical && state.showTechnical) {
    trace.hidden = false;
    trace.querySelector("pre")!.textContent = JSON.stringify(technical, null, 2);
  }
  chatEl.appendChild(node);
  chatEl.scrollTop = chatEl.scrollHeight;
  return node;
}

function addAssistantShell(technical: Record<string, unknown>) {
  removeEmpty();
  const node = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.classList.add("assistant");
  node.querySelector<HTMLElement>(".message-head")!.textContent = "BILAtiny";
  const answer = node.querySelector<HTMLElement>(".answer")!;
  answer.textContent = "…";
  const trace = node.querySelector<HTMLDetailsElement>(".trace")!;
  const pre = trace.querySelector<HTMLPreElement>("pre")!;
  const status = trace.querySelector<HTMLElement>(".trace-status")!;
  if (state.showTechnical) {
    trace.hidden = false;
    pre.textContent = JSON.stringify(technical, null, 2);
  }
  chatEl.appendChild(node);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { node, answer, trace, pre, status };
}

function buildUserPayload(unicode: string, cvnss: string): string {
  return [
    "[UNICODE_VI]",
    unicode,
    "",
    "[CVNSS4_WORKING_REPRESENTATION]",
    cvnss,
    "",
    "Chỉ xuất câu trả lời cuối cùng bằng tiếng Việt Unicode NFC.",
  ].join("\n");
}

function openRouterHeaders(): Record<string, string> {
  const referer = ["http:", "https:"].includes(location.protocol)
    ? location.href.split("#")[0]!
    : "https://vietflexmap.github.io/laya/";
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + state.apiKey,
    "HTTP-Referer": referer,
    "X-Title": "BILAtiny CVNSS4.0 + Laya Web",
  };
}

async function streamDeepSeek(
  ui: ReturnType<typeof addAssistantShell>,
  unicode: string,
  cvnss: string,
  decision: Record<string, any>,
  signal: AbortSignal,
) {
  if (!state.apiKey) {
    const error = new Error("Chưa có OpenRouter API key. Mở Cài đặt để nhập key.");
    (error as Error & { code?: string }).code = "NO_API_KEY";
    throw error;
  }

  const body: Record<string, unknown> = {
    model: state.deepseekModel,
    stream: true,
    max_tokens: DEFAULTS.maxTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...state.history.slice(-12),
      { role: "user", content: buildUserPayload(unicode, cvnss) },
    ],
  };
  if (decision.thinking) body.reasoning = { enabled: true };

  const response = await fetch(state.apiUrl, {
    method: "POST",
    signal,
    headers: openRouterHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`API HTTP ${response.status}${detail ? ": " + detail.slice(0, 500) : ""}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: unknown = null;
  ui.answer.textContent = "";
  ui.status.textContent = "streaming";

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta ?? {};
      // Intentionally ignore reasoning / reasoning_content. Only final answer content is rendered.
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        ui.answer.textContent = nfc(content);
      }
      if (json.usage) usage = json.usage;
    } catch {
      // Partial or non-JSON SSE line; ignore.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    chatEl.scrollTop = chatEl.scrollHeight;
  }
  if (buffer) consumeLine(buffer);

  const finalContent = nfc(content || "(Không có phản hồi)");
  ui.answer.textContent = finalContent;
  ui.status.textContent = "done";
  return { content: finalContent, usage };
}

function runOffline(ui: ReturnType<typeof addAssistantShell>, text: string, reason: string): void {
  try {
    const looksLikeCvss =
      /^[a-z\s.,!?;:'"()\-]+$/i.test(text) &&
      !/[đăâêôơưàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/i.test(text);
    ui.answer.textContent = looksLikeCvss
      ? "Giải mã CVNSS4.0 → Unicode:\n\n" + decodeCVNSS(text)
      : "Mã hóa Unicode → CVNSS4.0:\n\n" + encodeCVNSS(text);
  } catch (error) {
    ui.answer.textContent = "Offline converter lỗi: " + String((error as Error)?.message ?? error);
  }
  ui.status.textContent = "offline";
  if (state.showTechnical) {
    ui.pre.textContent = JSON.stringify({ offline: true, reason }, null, 2);
  }
}

async function send(raw: string): Promise<void> {
  if (state.busy) return;
  const unicode = nfc(raw).trim();
  if (!unicode) return;

  const cvnss = encodeCVNSS(unicode);
  addMessage("user", unicode, { cvnss4: cvnss });
  inputEl.value = "";
  inputEl.style.height = "auto";
  state.busy = true;
  sendBtn.disabled = true;

  try {
    if (state.mode === "offline") {
      const ui = addAssistantShell({ decision: { source: "offline" }, cvnss4: cvnss });
      runOffline(ui, unicode, "Offline mode");
      return;
    }

    const decision = state.mode === "laya"
      ? await webLayaDecision(unicode)
      : { ...localDecision(unicode, "API direct mode"), source: "api-direct" };

    const technical: Record<string, unknown> = {
      cvnss4: cvnss,
      decision,
      model: state.deepseekModel,
      laya_model_url: state.mode === "laya" ? state.layaModelUrl : undefined,
    };
    const ui = addAssistantShell(technical);
    ui.status.textContent = String(decision.source ?? "ready");

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
    try {
      const result = await streamDeepSeek(ui, unicode, cvnss, decision, controller.signal);
      state.history.push({ role: "user", content: buildUserPayload(unicode, cvnss) });
      state.history.push({ role: "assistant", content: result.content });
      if (result.usage && state.showTechnical) {
        technical.usage = result.usage;
        ui.pre.textContent = JSON.stringify(technical, null, 2);
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === "NO_API_KEY") {
        ui.answer.textContent = err.message;
        ui.status.textContent = "setup";
        settingsDialog.showModal();
      } else {
        ui.answer.textContent = "Không gọi được DeepSeek API: " + String(err.message ?? error);
        ui.status.textContent = "error";
      }
    } finally {
      clearTimeout(timer);
    }
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

function refreshSettings(): void {
  $<HTMLInputElement>("apiKey").value = state.apiKey;
  $<HTMLInputElement>("apiUrl").value = state.apiUrl;
  $<HTMLInputElement>("deepseekModel").value = state.deepseekModel;
  $<HTMLInputElement>("layaModelUrl").value = state.layaModelUrl;
  $<HTMLInputElement>("showTechnical").checked = state.showTechnical;
  setStatus("apiStatus", state.apiKey ? "DeepSeek API: ready" : "DeepSeek API: cần key");
}

function saveSettings(): void {
  const oldModelUrl = state.layaModelUrl;
  state.apiKey = $<HTMLInputElement>("apiKey").value.trim();
  state.apiUrl = $<HTMLInputElement>("apiUrl").value.trim() || DEFAULTS.apiUrl;
  state.deepseekModel = $<HTMLInputElement>("deepseekModel").value.trim() || DEFAULTS.deepseekModel;
  state.layaModelUrl = $<HTMLInputElement>("layaModelUrl").value.trim() || DEFAULTS.layaModelUrl;
  state.showTechnical = $<HTMLInputElement>("showTechnical").checked;

  sessionStorage.setItem("bilatiny.openrouterKey", state.apiKey);
  sessionStorage.setItem("bilatiny.apiUrl", state.apiUrl);
  sessionStorage.setItem("bilatiny.deepseekModel", state.deepseekModel);
  sessionStorage.setItem("bilatiny.layaModelUrl", state.layaModelUrl);
  sessionStorage.setItem("bilatiny.showTechnical", state.showTechnical ? "1" : "0");

  if (oldModelUrl !== state.layaModelUrl) {
    layaLoaded = null;
    layaLoadPromise = null;
    layaLoadedFrom = "";
    setStatus("layaStatus", "Laya: model URL đã đổi");
    setStatus("providerStatus", "Runtime: —");
  }
  refreshSettings();
  settingsDialog.close();
}

function clearConversation(): void {
  state.history.length = 0;
  chatEl.querySelectorAll(".message").forEach((node) => node.remove());
  location.reload();
}

modeBtn.addEventListener("click", cycleMode);
$<HTMLButtonElement>("settingsBtn").addEventListener("click", () => settingsDialog.showModal());
$<HTMLButtonElement>("clearBtn").addEventListener("click", clearConversation);
sendBtn.addEventListener("click", () => void send(inputEl.value));
$<HTMLButtonElement>("saveBtn").addEventListener("click", saveSettings);
$<HTMLButtonElement>("preloadBtn").addEventListener("click", async () => {
  saveSettings();
  try {
    await ensureLaya();
  } catch (error) {
    addMessage("system", "Không tải được Laya Web: " + String((error as Error)?.message ?? error));
  }
});

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send(inputEl.value);
  }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 170) + "px";
});

document.querySelectorAll<HTMLElement>("[data-prompt]").forEach((chip) => {
  chip.addEventListener("click", () => {
    inputEl.value = chip.dataset.prompt ?? "";
    inputEl.focus();
  });
});

try {
  const selfTest = CVN.selfTest();
  setStatus("cvnssStatus", selfTest.ok ? `CVNSS: ${CVN.VERSION} · OK` : "CVNSS: self-test lỗi");
} catch (error) {
  console.error(error);
  setStatus("cvnssStatus", "CVNSS: lỗi");
}

if (!("gpu" in navigator)) {
  setStatus("providerStatus", "Runtime: WASM candidate");
} else {
  setStatus("providerStatus", "Runtime: WebGPU candidate");
}

setMode(state.mode);
refreshSettings();
inputEl.focus();

window.__bilatiny = {
  encodeCVNSS,
  decodeCVNSS,
  ensureLaya,
  webLayaDecision,
  config: () => ({
    mode: state.mode,
    apiUrl: state.apiUrl,
    deepseekModel: state.deepseekModel,
    layaModelUrl: state.layaModelUrl,
    hasApiKey: Boolean(state.apiKey),
    provider: layaLoaded?.provider ?? null,
  }),
};
