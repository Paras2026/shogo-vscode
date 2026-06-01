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
    roleEl.textContent = role === "user" ? "You" : role === "error" ? "Error" : role === "tool" ? "Tool" : role === "approval" ? "Approval" : "Shogo";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") {
      bubble.innerHTML = "";
    } else {
      bubble.textContent = text;
    }

    wrap.appendChild(roleEl);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  function addApprovalCard(request) {
    const bubble = addMessage("approval", "");
    bubble.textContent = "";

    const card = document.createElement("div");
    card.className = "approval-card " + (request.kind || "approval");

    const header = document.createElement("div");
    header.className = "approval-header";

    const icon = document.createElement("div");
    icon.className = "approval-icon";
    icon.textContent = request.kind === "command" ? "▸" : "✎";

    const heading = document.createElement("div");
    heading.className = "approval-heading";

    const title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = request.title || "Approval required";

    const description = document.createElement("div");
    description.className = "approval-description";
    description.textContent = request.description || "";

    heading.appendChild(title);
    heading.appendChild(description);
    header.appendChild(icon);
    header.appendChild(heading);
    card.appendChild(header);

    if (request.details && typeof request.details === "object") {
      const details = document.createElement("div");
      details.className = "approval-details";
      Object.keys(request.details).forEach((key) => {
        const value = request.details[key];
        if (value === undefined || value === null || value === "") {
          return;
        }
        const row = document.createElement("div");
        row.className = "approval-detail-row";
        const label = document.createElement("span");
        label.className = "approval-detail-label";
        label.textContent = key;
        const detailValue = document.createElement("span");
        detailValue.className = "approval-detail-value";
        detailValue.textContent = String(value);
        row.appendChild(label);
        row.appendChild(detailValue);
        details.appendChild(row);
      });
      card.appendChild(details);
    }

    const actions = document.createElement("div");
    actions.className = "approval-actions";

    const primary = document.createElement("button");
    primary.className = "approval-primary";
    primary.textContent = request.primaryAction || "Approve";

    const secondary = document.createElement("button");
    secondary.className = "approval-secondary";
    secondary.textContent = request.secondaryAction || "Cancel";

    function respond(approved) {
      primary.disabled = true;
      secondary.disabled = true;
      card.classList.add(approved ? "approved" : "rejected");
      const status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = approved ? "Approved" : "Rejected";
      card.appendChild(status);
      vscode.postMessage({ type: "approvalResponse", id: request.id, approved: approved });
    }

    primary.addEventListener("click", () => respond(true));
    secondary.addEventListener("click", () => respond(false));

    actions.appendChild(primary);
    actions.appendChild(secondary);
    card.appendChild(actions);
    bubble.appendChild(card);
    scrollToBottom();
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || streaming) {
      return;
    }
    inputEl.value = "";
    vscode.postMessage({ type: "prompt", text: text });
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  setKeyBtn.addEventListener("click", () => vscode.postMessage({ type: "setKey" }));

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("cursor");
        }
        currentAssistantEl = null;
        setStreaming(false);
        break;
      case "toolActivity":
        addMessage("tool", msg.text);
        break;
      case "approvalRequest":
        addApprovalCard(msg.request || {});
        break;
      case "error":
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("cursor");
          currentAssistantEl = null;
        }
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
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Minimal, safe Markdown renderer: fenced code, inline code, bold, links, line breaks.
  function renderMarkdown(src) {
    const codeBlocks = [];
    let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(
        '<pre><code class="language-' +
          escapeHtml(lang) +
          '">' +
          escapeHtml(code.replace(/\n$/, "")) +
          "</code></pre>"
      );
      return "\u0000CODE" + idx + "\u0000";
    });

    text = escapeHtml(text);

    text = text.replace(/`([^`\n]+)`/g, (_m, c) => "<code>" + c + "</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2">$1</a>'
    );
    text = text.replace(/\n/g, "<br/>");

    text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)]);
    return text;
  }

  vscode.postMessage({ type: "ready" });
})();
