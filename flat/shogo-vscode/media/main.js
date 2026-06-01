(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const authBanner = document.getElementById("auth-banner");
  const setKeyBtn = document.getElementById("set-key-btn");

  let currentAssistantRaw = "";
  let currentAssistantEl = null;
  let streaming = false;

  function setStreaming(on) {
    streaming = on;
    sendBtn.classList.toggle("hidden", on);
    stopBtn.classList.toggle("hidden", !on);
    inputEl.disabled = on;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const roleEl = document.createElement("div");
    roleEl.className = "role";
    roleEl.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Shogo";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") { bubble.innerHTML = ""; } else { bubble.textContent = text; }
    wrap.appendChild(roleEl);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || streaming) { return; }
    inputEl.value = "";
    vscode.postMessage({ type: "prompt", text: text });
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  setKeyBtn.addEventListener("click", () => vscode.postMessage({ type: "setKey" }));

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "authState":
        authBanner.classList.toggle("hidden", msg.hasKey);
        break;
      case "userMessage":
        addMessage("user", msg.text);
        break;
      case "assistantStart":
        setStreaming(true);
        currentAssistantRaw = "";
        currentAssistantEl = addMessage("assistant", "");
        currentAssistantEl.classList.add("cursor");
        break;
      case "assistantToken":
        if (currentAssistantEl) {
          currentAssistantRaw += msg.text;
          currentAssistantEl.innerHTML = renderMarkdown(currentAssistantRaw);
          scrollToBottom();
        }
        break;
      case "assistantEnd":
        if (currentAssistantEl) { currentAssistantEl.classList.remove("cursor"); }
        currentAssistantEl = null;
        setStreaming(false);
        break;
      case "error":
        if (currentAssistantEl) { currentAssistantEl.classList.remove("cursor"); currentAssistantEl = null; }
        addMessage("error", msg.text);
        setStreaming(false);
        break;
      case "clear":
        messagesEl.innerHTML = "";
        currentAssistantRaw = "";
        currentAssistantEl = null;
        setStreaming(false);
        break;
    }
  });

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push('<pre><code class="language-' + escapeHtml(lang) + '">' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>");
      return "\u0000CODE" + idx + "\u0000";
    });
    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, (_m, c) => "<code>" + c + "</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
    text = text.replace(/\n/g, "<br/>");
    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)]);
    return text;
  }

  vscode.postMessage({ type: "ready" });
})();
