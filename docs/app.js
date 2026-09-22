(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const messages = $("messages");
  const form = $("chatForm");
  const prompt = $("prompt");
  const sendBtn = $("sendBtn");
  const settings = $("settingsDialog");
  const template = $("messageTemplate");

  const state = {
    history: [],
    backendUrl: sessionStorage.getItem("bilatiny.backendUrl") || "http://127.0.0.1:8787",
    apiKey: sessionStorage.getItem("bilatiny.deepseekKey") || "",
    model: sessionStorage.getItem("bilatiny.model") || "deepseek-v4-flash",
    forceThinking: sessionStorage.getItem("bilatiny.forceThinking") === "1",
  };

  function normalVi(text) {
    return String(text ?? "").normalize("NFC");
  }

  function toCvnss(text) {
    if (!globalThis.CVNSSConverter) throw new Error("CVNSSConverter chưa được nạp.");
    return globalThis.CVNSSConverter.fromCqn(normalVi(text)).cvss;
  }

  function addMessage(role, text, meta = null, cssClass = "") {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(role, cssClass);
    node.querySelector(".message-role").textContent = role === "user" ? "Bạn" : role === "assistant" ? "BILAtiny" : "Hệ thống";
    node.querySelector(".message-body").textContent = normalVi(text);
    const details = node.querySelector(".meta");
    if (meta) {
      details.hidden = false;
      details.querySelector("pre").textContent = JSON.stringify(meta, null, 2);
    }
    messages.appendChild(node);
    messages.scrollTop = messages.scrollHeight;
    return node;
  }

  async function health() {
    const base = state.backendUrl.replace(/\/$/, "");
    try {
      const r = await fetch(`${base}/api/health`, { headers: state.apiKey ? {"X-DeepSeek-Key": state.apiKey} : {} });
      const data = await r.json();
      $("backendStatus").textContent = r.ok ? `Backend: OK · ${data.deepseek_model}` : "Backend: lỗi";
      $("layaStatus").textContent = `Laya: ${data.laya_enabled ? "bật" : "tắt"}`;
      return r.ok;
    } catch (err) {
      $("backendStatus").textContent = "Backend: không kết nối";
      $("layaStatus").textContent = "Laya: chưa rõ";
      return false;
    }
  }

  async function sendMessage(text) {
    const unicode = normalVi(text).trim();
    if (!unicode) return;

    const cvnss = toCvnss(unicode);
    addMessage("user", unicode, $("showCvnss").checked ? { cvnss } : null);
    state.history.push({ role: "user", content: unicode });

    sendBtn.disabled = true;
    sendBtn.textContent = "Đang xử lý…";

    try {
      const base = state.backendUrl.replace(/\/$/, "");
      const headers = { "Content-Type": "application/json" };
      if (state.apiKey) headers["X-DeepSeek-Key"] = state.apiKey;

      const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          message_unicode: unicode,
          message_cvnss: cvnss,
          history: state.history.slice(-12, -1),
          model: state.model,
          force_thinking: state.forceThinking,
        }),
      });

      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);

      const answer = normalVi(data.answer);
      state.history.push({ role: "assistant", content: answer });
      addMessage("assistant", answer, {
        cvnss_input: $("showCvnss").checked ? cvnss : undefined,
        decision: data.decision,
        model: data.model,
        usage: data.usage,
      });
      $("layaStatus").textContent = `Laya: ${data.decision?.source || "n/a"} · ${data.decision?.mode || "n/a"}`;
    } catch (err) {
      addMessage("system", `Không gửi được yêu cầu: ${err.message}`, null, "error");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Gửi";
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = prompt.value;
    prompt.value = "";
    sendMessage(text);
  });

  $("settingsBtn").addEventListener("click", () => settings.showModal());
  $("backendUrl").value = state.backendUrl;
  $("apiKey").value = state.apiKey;
  $("model").value = state.model;
  $("forceThinking").checked = state.forceThinking;

  $("saveBtn").addEventListener("click", () => {
    state.backendUrl = $("backendUrl").value.trim().replace(/\/$/, "");
    state.apiKey = $("apiKey").value.trim();
    state.model = $("model").value;
    state.forceThinking = $("forceThinking").checked;
    sessionStorage.setItem("bilatiny.backendUrl", state.backendUrl);
    sessionStorage.setItem("bilatiny.deepseekKey", state.apiKey);
    sessionStorage.setItem("bilatiny.model", state.model);
    sessionStorage.setItem("bilatiny.forceThinking", state.forceThinking ? "1" : "0");
    settings.close();
    health();
  });

  $("testBtn").addEventListener("click", () => {
    state.backendUrl = $("backendUrl").value.trim().replace(/\/$/, "");
    state.apiKey = $("apiKey").value.trim();
    health();
  });

  try {
    const test = globalThis.CVNSSConverter?.selfTest?.();
    $("cvnssStatus").textContent = test?.ok ? `CVNSS: ${globalThis.CVNSSConverter.VERSION} · OK` : "CVNSS: self-test lỗi";
  } catch {
    $("cvnssStatus").textContent = "CVNSS: lỗi nạp";
  }

  addMessage("assistant", "Xin chào. Tôi hiển thị câu trả lời bằng tiếng Việt Unicode chuẩn NFC. CVNSS4.0 được dùng như biểu diễn làm việc trung gian; Laya chọn chế độ xử lý nhanh hay suy luận sâu.");
  health();
})();
