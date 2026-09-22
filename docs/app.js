(() => {
  "use strict";

  const CVN = globalThis.CVNSSConverter;
  if (!CVN) {
    console.error("CVNSSConverter not loaded");
    return;
  }

  const DEFAULTS = Object.freeze({
    apiUrl: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-v4-pro-0813",
    maxTokens: 4096,
    timeoutMs: 60000,
    layaUrl: location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:8787"
      : "",
  });

  const SYSTEM_PROMPT = [
    "Bạn là BILAtiny, trợ lý tiếng Việt.",
    "Mỗi yêu cầu có thể gồm bản Unicode tiếng Việt và biểu diễn CVNSS4.0 tương ứng.",
    "Hãy dùng CVNSS4.0 như một biểu diễn làm việc phụ trợ để giữ nhất quán tiếng Việt, nhưng không được giả vờ rằng đây là chain-of-thought bắt buộc của mô hình.",
    "Không xuất chain-of-thought, reasoning_content hay suy luận nội bộ.",
    "Chỉ trả lời cuối cùng hữu ích bằng tiếng Việt Unicode chuẩn NFC, trừ khi người dùng yêu cầu rõ ràng mã CVNSS4.0.",
    "Khi trả code, giữ nguyên cú pháp code; phần giải thích vẫn bằng tiếng Việt Unicode."
  ].join("\n");

  const $ = (id) => document.getElementById(id);
  const chatEl = $("chat");
  const emptyEl = $("empty");
  const inputEl = $("input");
  const sendBtn = $("send");
  const clearBtn = $("clearBtn");
  const modeBtn = $("modeBtn");
  const modeLabel = $("modeLabel");
  const settingsBtn = $("settingsBtn");
  const settingsDialog = $("settingsDialog");
  const template = $("messageTemplate");

  const state = {
    mode: sessionStorage.getItem("bilatiny.mode") || "auto",
    apiKey: sessionStorage.getItem("bilatiny.openrouterKey") || "",
    apiUrl: sessionStorage.getItem("bilatiny.apiUrl") || DEFAULTS.apiUrl,
    model: sessionStorage.getItem("bilatiny.model") || DEFAULTS.model,
    layaUrl: sessionStorage.getItem("bilatiny.layaUrl") ?? DEFAULTS.layaUrl,
    showTechnical: sessionStorage.getItem("bilatiny.showTechnical") === "1",
    history: [],
    busy: false,
  };

  function nfc(value) {
    return String(value ?? "").normalize("NFC");
  }

  function enc(text) {
    return CVN.fromCqn(nfc(text)).cvss;
  }

  function dec(text) {
    return CVN.fromCvss(String(text ?? "")).cqn.normalize("NFC");
  }

  function setStatus(id, text) {
    $(id).textContent = text;
  }

  function setMode(next) {
    state.mode = next;
    sessionStorage.setItem("bilatiny.mode", next);
    modeBtn.className = "btn " + (
      next === "auto" ? "mode-auto" :
      next === "api" ? "mode-api" : "mode-offline"
    );
    modeLabel.textContent = next === "auto" ? "Auto" : next === "api" ? "API" : "Offline";
    modeBtn.title =
      next === "auto" ? "Auto: API trực tiếp, lỗi thì chuyển Offline" :
      next === "api" ? "Chỉ gọi API trực tiếp" :
      "Chỉ chạy CVNSS4.0 cục bộ";
  }

  function cycleMode() {
    setMode(state.mode === "auto" ? "api" : state.mode === "api" ? "offline" : "auto");
  }

  function addMessage(role, text, technical = null) {
    emptyEl?.remove();
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(role);
    node.querySelector(".head").textContent =
      role === "user" ? "Bạn" : role === "assistant" ? "BILAtiny" : "Hệ thống";
    node.querySelector(".answer").textContent = nfc(text);

    const details = node.querySelector(".decision");
    if (technical && state.showTechnical) {
      details.hidden = false;
      details.querySelector("pre").textContent = JSON.stringify(technical, null, 2);
      details.querySelector(".decision-status").textContent = technical.decision?.source || "ready";
    }

    chatEl.appendChild(node);
    chatEl.scrollTop = chatEl.scrollHeight;
    return node;
  }

  function createAssistantShell(technical) {
    emptyEl?.remove();
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add("assistant");
    node.querySelector(".head").textContent = "BILAtiny";
    node.querySelector(".answer").textContent = "…";
    const details = node.querySelector(".decision");
    if (state.showTechnical) {
      details.hidden = false;
      details.querySelector("pre").textContent = JSON.stringify(technical, null, 2);
      details.querySelector(".decision-status").textContent = technical.decision?.source || "routing";
    }
    chatEl.appendChild(node);
    chatEl.scrollTop = chatEl.scrollHeight;
    return {
      node,
      answer: node.querySelector(".answer"),
      details,
      pre: details.querySelector("pre"),
      status: details.querySelector(".decision-status"),
    };
  }

  function localDecision(text) {
    const s = nfc(text).toLowerCase();
    const codeTerms = ["code", "python", "javascript", "typescript", "rust", "api", "github", "bug", "debug", "lỗi", "kiến trúc", "refactor"];
    const deepTerms = ["phân tích", "so sánh", "thiết kế", "tối ưu", "chiến lược", "vì sao", "kế hoạch", "đánh giá", "mô hình"];
    let mode = "fast";
    let domain = "general";
    if (codeTerms.some((x) => s.includes(x))) {
      mode = "code";
      domain = "code";
    } else if (s.length > 900 || deepTerms.some((x) => s.includes(x))) {
      mode = "think";
      domain = "reasoning";
    }
    return {
      mode,
      domain,
      confidence: 0.55,
      source: "local-fallback",
      thinking: mode !== "fast",
    };
  }

  async function layaDecision(unicode, cvnss) {
    const base = state.layaUrl.trim().replace(/\/$/, "");
    if (!base) return localDecision(unicode);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(base + "/api/decide", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_unicode: unicode, message_cvnss: cvnss }),
      });
      if (!res.ok) throw new Error("Laya HTTP " + res.status);
      const data = await res.json();
      setStatus("layaStatus", "Laya: " + (data.model || data.source || "online"));
      return data;
    } catch (err) {
      setStatus("layaStatus", "Laya: fallback cục bộ");
      const fallback = localDecision(unicode);
      fallback.laya_error = String(err?.message || err);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  function buildUserPayload(unicode, cvnss) {
    return [
      "[UNICODE_VI]",
      unicode,
      "",
      "[CVNSS4_WORKING_REPRESENTATION]",
      cvnss,
      "",
      "Trả lời cuối cùng bằng tiếng Việt Unicode NFC."
    ].join("\n");
  }

  function openRouterHeaders() {
    const referer = location.protocol === "http:" || location.protocol === "https:"
      ? location.origin + location.pathname
      : "https://vietflexmap.github.io/laya/";
    return {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + state.apiKey,
      "HTTP-Referer": referer,
      "X-Title": "BILAtiny CVNSS4.0",
    };
  }

  async function streamOpenRouter(ui, unicode, cvnss, decision, signal) {
    if (!state.apiKey) {
      const err = new Error("Chưa có OpenRouter API key. Mở Cài đặt để nhập key.");
      err.code = "NO_API_KEY";
      throw err;
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...state.history.slice(-12),
      { role: "user", content: buildUserPayload(unicode, cvnss) },
    ];

    const body = {
      model: state.model,
      stream: true,
      max_tokens: DEFAULTS.maxTokens,
      messages,
    };
    if (decision.thinking) body.reasoning = { enabled: true };

    const res = await fetch(state.apiUrl, {
      method: "POST",
      signal,
      headers: openRouterHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error("API HTTP " + res.status + (detail ? ": " + detail.slice(0, 500) : ""));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let usage = null;

    ui.answer.textContent = "";
    ui.status.textContent = "streaming";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta || {};
          // Deliberately ignore reasoning / reasoning_content. Only final content is rendered.
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            ui.answer.textContent = nfc(content);
          }
          if (json.usage) usage = json.usage;
        } catch {
          // Ignore malformed/partial SSE lines.
        }
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    content = nfc(content || "(Không có phản hồi)");
    ui.answer.textContent = content;
    ui.status.textContent = "done";
    return { content, usage };
  }

  function runOffline(ui, text, reason) {
    let answer;
    try {
      const looksLikeCvss = /^[a-z\s.,!?;:'"()\-]+$/i.test(text) && !/[đăâêôơư]/i.test(text);
      answer = looksLikeCvss
        ? "Giải mã CVNSS4.0 → Unicode:\n\n" + dec(text)
        : "Mã hóa Unicode → CVNSS4.0:\n\n" + enc(text);
    } catch (err) {
      answer = "Offline converter lỗi: " + String(err?.message || err);
    }
    ui.answer.textContent = nfc(answer);
    ui.status.textContent = "offline";
    if (state.showTechnical) {
      ui.pre.textContent = JSON.stringify({ offline: true, reason }, null, 2);
    }
  }

  async function send(text) {
    if (state.busy) return;
    const unicode = nfc(text).trim();
    if (!unicode) return;

    const cvnss = enc(unicode);
    addMessage("user", unicode, state.showTechnical ? { cvnss4: cvnss } : null);
    inputEl.value = "";
    inputEl.style.height = "auto";

    state.busy = true;
    sendBtn.disabled = true;

    try {
      if (state.mode === "offline") {
        const ui = createAssistantShell({ decision: { source: "offline" }, cvnss4: cvnss });
        runOffline(ui, unicode, "Chế độ Offline được chọn.");
        return;
      }

      const decision = await layaDecision(unicode, cvnss);
      const technical = { decision, cvnss4: cvnss, model: state.model };
      const ui = createAssistantShell(technical);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
      try {
        const result = await streamOpenRouter(ui, unicode, cvnss, decision, controller.signal);
        state.history.push({ role: "user", content: buildUserPayload(unicode, cvnss) });
        state.history.push({ role: "assistant", content: result.content });
        if (state.showTechnical && result.usage) {
          technical.usage = result.usage;
          ui.pre.textContent = JSON.stringify(technical, null, 2);
        }
      } catch (err) {
        if (err?.code === "NO_API_KEY") {
          ui.answer.textContent = err.message;
          ui.status.textContent = "setup";
          settingsDialog.showModal();
        } else if (state.mode === "auto") {
          runOffline(ui, unicode, "API lỗi → fallback Offline: " + String(err?.message || err));
        } else {
          ui.answer.textContent = "Không gọi được API: " + String(err?.message || err);
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

  function refreshConfigUi() {
    $("apiKey").value = state.apiKey;
    $("apiUrl").value = state.apiUrl;
    $("model").value = state.model;
    $("layaUrl").value = state.layaUrl;
    $("showTechnical").checked = state.showTechnical;
    setStatus("apiStatus", state.apiKey ? "API trực tiếp: sẵn sàng" : "API trực tiếp: cần key");
    setStatus("layaStatus", state.layaUrl ? "Laya: endpoint đã cấu hình" : "Laya: local fallback");
  }

  function saveSettings() {
    state.apiKey = $("apiKey").value.trim();
    state.apiUrl = $("apiUrl").value.trim() || DEFAULTS.apiUrl;
    state.model = $("model").value.trim() || DEFAULTS.model;
    state.layaUrl = $("layaUrl").value.trim();
    state.showTechnical = $("showTechnical").checked;

    sessionStorage.setItem("bilatiny.openrouterKey", state.apiKey);
    sessionStorage.setItem("bilatiny.apiUrl", state.apiUrl);
    sessionStorage.setItem("bilatiny.model", state.model);
    sessionStorage.setItem("bilatiny.layaUrl", state.layaUrl);
    sessionStorage.setItem("bilatiny.showTechnical", state.showTechnical ? "1" : "0");
    refreshConfigUi();
    settingsDialog.close();
  }

  function clearConversation() {
    state.history = [];
    chatEl.querySelectorAll(".msg").forEach((x) => x.remove());
    if (!document.getElementById("empty")) location.reload();
  }

  modeBtn.addEventListener("click", cycleMode);
  settingsBtn.addEventListener("click", () => settingsDialog.showModal());
  clearBtn.addEventListener("click", clearConversation);
  sendBtn.addEventListener("click", () => send(inputEl.value));
  $("saveBtn").addEventListener("click", saveSettings);
  $("testApiBtn").addEventListener("click", () => {
    const hasKey = Boolean($("apiKey").value.trim());
    const hasUrl = Boolean($("apiUrl").value.trim());
    alert(hasKey && hasUrl
      ? "Cấu hình hợp lệ về hình thức. Nhấn Lưu phiên rồi gửi một tin nhắn để kiểm tra API thực tế."
      : "Cần API URL và API key.");
  });

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(inputEl.value);
    }
  });
  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 170) + "px";
  });

  document.querySelectorAll("[data-prompt]").forEach((chip) => {
    chip.addEventListener("click", () => {
      inputEl.value = chip.dataset.prompt || "";
      inputEl.focus();
    });
  });

  try {
    const test = CVN.selfTest();
    setStatus("cvnssStatus", test.ok ? "CVNSS: " + CVN.VERSION + " · OK" : "CVNSS: self-test lỗi");
  } catch (err) {
    setStatus("cvnssStatus", "CVNSS: lỗi");
    console.error(err);
  }

  setMode(state.mode);
  refreshConfigUi();
  inputEl.focus();

  globalThis.__bilatiny = {
    encode: enc,
    decode: dec,
    localDecision,
    config: () => ({
      mode: state.mode,
      apiUrl: state.apiUrl,
      model: state.model,
      layaUrl: state.layaUrl,
      hasApiKey: Boolean(state.apiKey),
    }),
  };
})();
