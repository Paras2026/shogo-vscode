(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send-btn");
  const stopBtn = document.getElementById("stop-btn");
  const authBanner = document.getElementById("auth-banner");
  const setKeyBtn = document.getElementById("set-key-btn");
  const sessionPanel = document.getElementById("session-panel");
  const sessionTitleDisplay = document.getElementById("session-title-display");
  const historyBtn = document.getElementById("history-btn");
  const exportBtn = document.getElementById("export-btn");
  const clearBtn = document.getElementById("clear-btn");
  const sessionListEl = document.getElementById("session-list");
  const modelSelect = document.getElementById("model-select");

  let currentAssistantRaw = "";
  let currentAssistantEl = null;
  let streaming = false;
  let selectedModel = "claude-sonnet-4-5";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let sessionListVisible = false;
  let availableModels = [];

  function setStreaming(on) {
    streaming = on;
    sendBtn.classList.toggle("hidden", on);
    stopBtn.classList.toggle("hidden", !on);
    inputEl.disabled = on;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMarkdown(src) {
    var codeBlocks = [];
    var text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_m, lang, code) {
      var idx = codeBlocks.length;
      var langClass = lang ? "language-" + escapeHtml(lang) : "";
      var blockId = "code-block-" + idx;
      codeBlocks.push(
        '<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">' +
          escapeHtml(lang || "code") +
          '</span><button class="copy-btn" data-block="' + blockId + '" title="Copy">Copy</button></div><pre id="' + blockId + '"><code class="' + langClass + '">' +
          escapeHtml(code.replace(/\n$/, "")) +
          "</code></pre></div>"
      );
      return "\u0000CODE" + idx + "\u0000";
    });

    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, function (_m, c) { return "<code>" + c + "</code>"; });
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\)\s]+)\)/g, '<a href="$2" target="blank">$1</a>');
    text = text.replace(/(?:^|\n)((?:src|lib|src\/|\.\/)[\w\-\.\/]+\.\w{1,5})(?:\n|$)/g, function (_m, filePath) {
      return '\n<span class="file-link" data-path="' + escapeHtml(filePath) + '">' + escapeHtml(filePath) + "</span>\n";
    });
    text = text.replace(/\n/g, "<br/>");
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (_m, i) { return codeBlocks[Number(i)]; });
    return text;
  }

  function addMessage(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;

    var roleEl = document.createElement("div");
    roleEl.className = "role";
    var labels = { user: "You", error: "Error", tool: "Tool", approval: "Approval", assistant: "Shogo" };
    roleEl.textContent = labels[role] || "Shogo";

    var bubble = document.createElement("div");
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

  function addTokenBar() {
    var existing = document.getElementById("token-bar");
    if (existing) existing.remove();
    var bar = document.createElement("div");
    bar.id = "token-bar";
    bar.className = "token-bar";
    bar.textContent = "~" + totalInputTokens + " in / ~" + totalOutputTokens + " out";
    messagesEl.appendChild(bar);
  }

  function addApprovalCard(request) {
    var bubble = addMessage("approval", "");
    bubble.textContent = "";

    var card = document.createElement("div");
    card.className = "approval-card " + (request.kind || "approval");
    card.dataset.approvalId = request.id;

    var header = document.createElement("div");
    header.className = "approval-header";

    var icon = document.createElement("div");
    icon.className = "approval-icon";
    icon.textContent = request.kind === "command" ? "\u25B8" : "\u270E";

    var heading = document.createElement("div");
    heading.className = "approval-heading";

    var title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = request.title || "Approval required";

    var description = document.createElement("div");
    description.className = "approval-description";
    description.textContent = request.description || "";

    heading.appendChild(title);
    heading.appendChild(description);
    header.appendChild(icon);
    header.appendChild(heading);
    card.appendChild(header);

    if (request.details) {
      var details = document.createElement("div");
      details.className = "approval-details";
      Object.keys(request.details).forEach(function (key) {
        var value = request.details[key];
        if (value === undefined || value === null || value === "") return;
        var row = document.createElement("div");
        row.className = "approval-detail-row";
        var label = document.createElement("span");
        label.className = "approval-detail-label";
        label.textContent = key;
        var detailValue = document.createElement("span");
        detailValue.className = "approval-detail-value";
        detailValue.textContent = String(value);
        row.appendChild(label);
        row.appendChild(detailValue);
        details.appendChild(row);
      });
      card.appendChild(details);
    }

    var actions = document.createElement("div");
    actions.className = "approval-actions";

    var primary = document.createElement("button");
    primary.className = "approval-primary";
    primary.textContent = request.primaryAction || "Approve";

    var secondary = document.createElement("button");
    secondary.className = "approval-secondary";
    secondary.textContent = request.secondaryAction || "Cancel";

    var approveAllBtn = document.createElement("button");
    approveAllBtn.className = "approval-approve-all";
    approveAllBtn.textContent = "Approve All";
    approveAllBtn.title = "Approve all pending";

    function respond(approved) {
      primary.disabled = true;
      secondary.disabled = true;
      approveAllBtn.disabled = true;
      card.classList.add(approved ? "approved" : "rejected");
      var status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = approved ? "Approved" : "Rejected";
      card.appendChild(status);
      vscode.postMessage({ type: "approvalResponse", id: request.id, approved: approved });
    }

    primary.addEventListener("click", function () { respond(true); });
    secondary.addEventListener("click", function () { respond(false); });
    approveAllBtn.addEventListener("click", function () {
      vscode.postMessage({ type: "approveAll" });
    });

    actions.appendChild(primary);
    actions.appendChild(approveAllBtn);
    actions.appendChild(secondary);
    card.appendChild(actions);
    bubble.appendChild(card);
    scrollToBottom();
  }

  function renderSessionList(sessions) {
    sessionListEl.innerHTML = "";
    if (!sessions || sessions.length === 0) {
      sessionListEl.innerHTML = '<div class="session-empty">No previous chats</div>';
      return;
    }
    sessions.forEach(function (s) {
      var item = document.createElement("div");
      item.className = "session-item";
      var titleEl = document.createElement("div");
      titleEl.className = "session-title";
      titleEl.textContent = s.title || "Chat";
      var metaEl = document.createElement("div");
      metaEl.className = "session-meta";
      var d = new Date(s.updatedAt);
      metaEl.textContent = d.toLocaleDateString() + " \u2022 " + s.messageCount + " msgs";
      item.appendChild(titleEl);
      item.appendChild(metaEl);
      item.addEventListener("click", function () {
        vscode.postMessage({ type: "loadSession", sessionId: s.id });
        sessionListEl.classList.add("hidden");
        sessionListVisible = false;
      });
      sessionListEl.appendChild(item);
    });
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || streaming) return;
    inputEl.value = "";
    vscode.postMessage({ type: "prompt", text: text, model: selectedModel });
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", function () { vscode.postMessage({ type: "stop" }); });
  setKeyBtn.addEventListener("click", function () { vscode.postMessage({ type: "setKey" }); });

  clearBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "newChat" });
    totalInputTokens = 0;
    totalOutputTokens = 0;
  });

  exportBtn.addEventListener("click", function () {
    vscode.postMessage({ type: "exportChat" });
  });

  historyBtn.addEventListener("click", function () {
    sessionListVisible = !sessionListVisible;
    sessionListEl.classList.toggle("hidden", !sessionListVisible);
    if (sessionListVisible) {
      vscode.postMessage({ type: "listSessions" });
    }
  });

  modelSelect.addEventListener("change", function () {
    selectedModel = modelSelect.value;
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  messagesEl.addEventListener("click", function (e) {
    var target = e.target;

    if (target.classList.contains("copy-btn")) {
      var blockId = target.getAttribute("data-block");
      var codeEl = document.getElementById(blockId);
      if (codeEl) {
        var text = codeEl.textContent;
        navigator.clipboard.writeText(text).then(function () {
          target.textContent = "Copied!";
          setTimeout(function () { target.textContent = "Copy"; }, 1500);
        });
      }
      return;
    }

    if (target.classList.contains("file-link")) {
      var path = target.getAttribute("data-path");
      if (path) {
        vscode.postMessage({ type: "openFile", path: path });
      }
      return;
    }
  });

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "authState":
        authBanner.classList.toggle("hidden", msg.hasKey);
        sessionPanel.classList.toggle("hidden", !msg.hasKey);
        break;
      case "userMessage":
        addMessage("user", msg.text);
        break;
      case "assistantStart":
        setStreaming(true);
        currentAssistantRaw = "";
        currentAssistantEl = null;
        break;
      case "assistantToken":
        if (!currentAssistantEl) {
          currentAssistantEl = addMessage("assistant", "");
          currentAssistantEl.classList.add("cursor");
        }
        currentAssistantRaw += msg.text;
        currentAssistantEl.innerHTML = renderMarkdown(currentAssistantRaw);
        scrollToBottom();
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
      case "approvalResponse":
        var cards = document.querySelectorAll('.approval-card[data-approval-id="' + msg.id + '"]');
        cards.forEach(function (card) {
          if (!card.classList.contains("approved") && !card.classList.contains("rejected")) {
            card.classList.add(msg.approved ? "approved" : "rejected");
            var status = document.createElement("div");
            status.className = "approval-status";
            status.textContent = msg.approved ? "Approved" : "Rejected";
            card.appendChild(status);
            card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
          }
        });
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
        sessionPanel.classList.add("hidden");
        break;
      case "sessionList":
        renderSessionList(msg.sessions);
        break;
      case "loadHistory":
        messagesEl.innerHTML = "";
        currentAssistantRaw = "";
        currentAssistantEl = null;
        if (msg.title) {
          sessionPanel.classList.remove("hidden");
          sessionTitleDisplay.textContent = msg.title;
        }
        if (msg.messages) {
          msg.messages.forEach(function (m) {
            if (m.role === "user") {
              addMessage("user", m.content);
            } else if (m.role === "assistant") {
              var b = addMessage("assistant", "");
              b.innerHTML = renderMarkdown(m.content);
            }
          });
        }
        break;
      case "chatTitle":
        sessionPanel.classList.remove("hidden");
        sessionTitleDisplay.textContent = msg.title;
        break;
      case "tokenUsage":
        totalInputTokens = msg.usage.inputTokens;
        totalOutputTokens = msg.usage.outputTokens;
        addTokenBar();
        break;
      case "models":
        availableModels = msg.models || [];
        modelSelect.innerHTML = "";
        availableModels.forEach(function (m) {
          var opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          if (m === selectedModel) opt.selected = true;
          modelSelect.appendChild(opt);
        });
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
