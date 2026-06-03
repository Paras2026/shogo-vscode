(function () {
  var vscode = acquireVsCodeApi();

  var messagesEl = document.getElementById("messages");
  var inputEl = document.getElementById("input");
  var sendBtn = document.getElementById("send-btn");
  var stopBtn = document.getElementById("stop-btn");
  var authBanner = document.getElementById("auth-banner");
  var setKeyBtn = document.getElementById("set-key-btn");
  var modelSelect = document.getElementById("model-select");
  var historyBtn = document.getElementById("history-btn");
  var historyDrawer = document.getElementById("history-drawer");
  var newChatBtn = document.getElementById("new-chat-btn");

  var currentAssistantRaw = "";
  var currentAssistantEl = null;
  var streaming = false;
  var chatTitle = "New Chat";
  var spinnerEl = null;

  function setStreaming(on) {
    streaming = on;
    sendBtn.classList.toggle("hidden", on);
    stopBtn.classList.toggle("hidden", !on);
    inputEl.disabled = on;

    if (on) {
      showSpinner();
    } else {
      hideSpinner();
    }
  }

  function showSpinner() {
    if (spinnerEl) return;
    var wrap = document.createElement("div");
    wrap.className = "spinner-wrap";
    wrap.innerHTML =
      '<div class="spinner"></div>' +
      '<span class="spinner-text">Thinking...</span>';
    messagesEl.appendChild(wrap);
    spinnerEl = wrap;
    scrollToBottom();
  }

  function hideSpinner() {
    if (spinnerEl) {
      spinnerEl.remove();
      spinnerEl = null;
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function linkifyFilePaths(text) {
    text = text.replace(
      /(?<![\"`\w])([\.\/]?\w[\w\-\/]*\.\w{1,5})\s*\(line\s+(\d+)\)/g,
      '<a href="#" class="file-link" data-path="$1" data-line="$2">$1 (line $2)</a>'
    );
    text = text.replace(
      /(?<![\"`\w])([\.\/]?\w[\w\-\/]*\.\w{1,5}):(\d+)/g,
      '<a href="#" class="file-link" data-path="$1" data-line="$2">$1:$2</a>'
    );
    text = text.replace(
      /(?<![\"`\w])([\.\/]?\w[\w\-\/]*\.\w{1,5})(?=\s|,|\.|$)/g,
      '<a href="#" class="file-link" data-path="$1">$1</a>'
    );
    return text;
  }

  function renderMarkdown(src) {
    var codeBlocks = [];
    var text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_m, lang, code) {
      var idx = codeBlocks.length;
      var langLabel = lang || "";
      var normalized = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      normalized = normalized.replace(/^\n/, "").replace(/\n$/, "");
      var escapedCode = escapeHtml(normalized);
      codeBlocks.push(
        '<div class="code-block-wrapper">' +
          '<div class="code-block-header"><span>' + escapeHtml(langLabel) + '</span><button class="copy-btn" onclick="window._copyCode(' + idx + ')">Copy</button></div>' +
          '<pre><code class="language-' + escapeHtml(langLabel) + '">' + escapedCode + "</code></pre></div>"
      );
      return "\u0000CODE" + idx + "\u0000";
    });

    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2">$1</a>'
    );
    text = linkifyFilePaths(text);
    text = text.replace(/\n/g, "<br/>");
    text = text.replace(/\u0000CODE(\d+)\u0000/g, function (_m, i) {
      return codeBlocks[Number(i)];
    });
    return text;
  }

  window._copyCode = function (idx) {
    var codeEl = document.querySelectorAll("pre code")[idx];
    if (codeEl) {
      navigator.clipboard.writeText(codeEl.textContent || "").then(function () {
        var btn = document.querySelectorAll(".copy-btn")[idx];
        if (btn) {
          btn.textContent = "Copied!";
          setTimeout(function () { btn.textContent = "Copy"; }, 1500);
        }
      });
    }
  };

  function addMessage(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + role;

    var roleEl = document.createElement("div");
    roleEl.className = "role";
    var labels = { user: "You", assistant: "Shogo", error: "Error", tool: "", approval: "" };
    roleEl.textContent = labels[role] || role;

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

  function addApprovalCard(request) {
    var bubble = addMessage("approval", "");

    var card = document.createElement("div");
    card.className = "approval-card " + (request.kind || "edit");

    var header = document.createElement("div");
    header.className = "approval-header";

    var icon = document.createElement("div");
    icon.className = "approval-icon";
    icon.textContent = request.kind === "command" ? "▸" : "✎";

    var heading = document.createElement("div");

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

    if (request.details && typeof request.details === "object") {
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

    function respond(approved) {
      primary.disabled = true;
      secondary.disabled = true;
      card.classList.add(approved ? "approved" : "rejected");
      var status = document.createElement("div");
      status.className = "approval-status";
      status.textContent = approved ? "✓ Approved" : "✗ Rejected";
      card.appendChild(status);
      vscode.postMessage({ type: "approvalResponse", id: request.id, approved: approved });
    }

    primary.addEventListener("click", function () { respond(true); });
    secondary.addEventListener("click", function () { respond(false); });

    actions.appendChild(primary);
    actions.appendChild(secondary);
    card.appendChild(actions);
    bubble.appendChild(card);
    scrollToBottom();
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || streaming) return;
    inputEl.value = "";
    var model = modelSelect.value;
    vscode.postMessage({ type: "prompt", text: text, model: model });
  }

  function toggleHistory() {
    var opening = !historyDrawer.classList.contains("open");
    historyDrawer.classList.toggle("open");
    if (opening) {
      vscode.postMessage({ type: "listSessions" });
    }
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", function () { vscode.postMessage({ type: "stop" }); });
  setKeyBtn.addEventListener("click", function () { vscode.postMessage({ type: "setKey" }); });
  historyBtn.addEventListener("click", toggleHistory);
  newChatBtn.addEventListener("click", function () {
    if (historyDrawer.classList.contains("open")) {
      historyDrawer.classList.remove("open");
    }
    vscode.postMessage({ type: "newChat" });
    chatTitle = "New Chat";
  });

  inputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  messagesEl.addEventListener("click", function (e) {
    var target = e.target;
    if (target.classList && target.classList.contains("file-link")) {
      var path = target.getAttribute("data-path");
      var line = target.getAttribute("data-line");
      if (path) {
        vscode.postMessage({ type: "openFile", path: path, line: line ? parseInt(line) : undefined });
      }
    }
  });

  window.addEventListener("message", function (event) {
    var msg = event.data;
    switch (msg.type) {
      case "authState":
        authBanner.classList.toggle("hidden", msg.hasKey);
        break;
      case "userMessage":
        addMessage("user", msg.text);
        if (chatTitle === "New Chat") {
          chatTitle = msg.text.slice(0, 40) + (msg.text.length > 40 ? "..." : "");
          document.getElementById("header-logo").textContent = "⚡ " + chatTitle;
        }
        break;
      case "assistantStart":
        setStreaming(true);
        currentAssistantRaw = "";
        currentAssistantEl = null;
        break;
      case "assistantToken":
        hideSpinner();
        if (!currentAssistantEl) {
          currentAssistantEl = addMessage("assistant", "");
          currentAssistantEl.classList.add("cursor");
        }
        currentAssistantRaw += msg.text;
        currentAssistantEl.innerHTML = renderMarkdown(currentAssistantRaw);
        scrollToBottom();
        break;
      case "assistantEnd":
        hideSpinner();
        if (currentAssistantEl) {
          currentAssistantEl.classList.remove("cursor");
          currentAssistantEl = null;
        }
        setStreaming(false);
        break;
      case "toolActivity":
        addMessage("tool", msg.text);
        break;
      case "approvalRequest":
        addApprovalCard(msg.request || {});
        break;
      case "error":
        hideSpinner();
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
        spinnerEl = null;
        setStreaming(false);
        chatTitle = "New Chat";
        document.getElementById("header-logo").textContent = "⚡ Shogo";
        break;
      case "sessionList":
        renderSessionList(msg.sessions || []);
        break;
    }
  });

  function renderSessionList(sessions) {
    historyDrawer.innerHTML = "";
    if (sessions.length === 0) {
      var empty = document.createElement("div");
      empty.style.cssText = "font-size:11px;opacity:0.4;padding:8px;text-align:center;";
      empty.textContent = "No previous sessions";
      historyDrawer.appendChild(empty);
      return;
    }
    sessions.forEach(function (session) {
      var item = document.createElement("div");
      item.className = "history-item";

      var titleSpan = document.createElement("span");
      titleSpan.className = "history-item-title";
      titleSpan.textContent = session.title || "Untitled";

      var meta = document.createElement("span");
      meta.className = "history-item-meta";
      meta.textContent = (session.messageCount || 0) + " msgs";

      var delBtn = document.createElement("button");
      delBtn.className = "history-item-delete";
      delBtn.textContent = "✕";
      delBtn.title = "Delete session";

      item.appendChild(titleSpan);
      item.appendChild(meta);
      item.appendChild(delBtn);

      item.addEventListener("click", function (e) {
        if (e.target === delBtn) {
          vscode.postMessage({ type: "deleteSession", sessionId: session.id });
          item.remove();
          return;
        }
        vscode.postMessage({ type: "loadSession", sessionId: session.id });
        historyDrawer.classList.remove("open");
      });

      historyDrawer.appendChild(item);
    });
  }

  vscode.postMessage({ type: "ready" });
})();
