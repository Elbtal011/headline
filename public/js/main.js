(function initChatWidget() {
  const launcher = document.getElementById('chat-launcher');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const messageInput = document.getElementById('chat-message-input');
  const fileInput = document.getElementById('chat-file-input');
  const fileBtn = document.getElementById('chat-file-btn');
  const fileLabel = document.getElementById('chat-file-label');
  const messagesEl = document.getElementById('chat-messages');
  const csrfInput = document.getElementById('chat-csrf');
  const sourceInput = document.getElementById('chat-source');

  if (!launcher || !panel || !form || !messagesEl || !csrfInput) {
    return;
  }

  const STORAGE_KEY = 'site_chat_session_v1';
  let chatId = null;
  let chatToken = null;
  let pollTimer = null;

  function updateFileLabel() {
    if (!fileLabel || !fileInput) return;
    const files = fileInput.files;
    if (!files || files.length === 0) {
      fileLabel.textContent = 'Keine Datei ausgewählt';
      return;
    }
    if (files.length === 1) {
      fileLabel.textContent = files[0].name;
      return;
    }
    fileLabel.textContent = `${files.length} Dateien ausgewählt`;
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      chatId = parsed.chatId || null;
      chatToken = parsed.chatToken || null;
    } catch (_err) {
      chatId = null;
      chatToken = null;
    }
  }

  function saveSession() {
    if (!chatId || !chatToken) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ chatId, chatToken }));
  }

  function clearSession() {
    chatId = null;
    chatToken = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  function appendMessageBubble(msg) {
    const bubble = document.createElement('article');
    bubble.className = `chat-bubble ${msg.sender_type === 'visitor' ? 'visitor' : 'admin'}`;

    const text = document.createElement('div');
    text.textContent = msg.message || '(Datei)';
    bubble.appendChild(text);

    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
      const filesWrap = document.createElement('div');
      filesWrap.className = 'chat-files';
      msg.attachments.forEach((file) => {
        const link = document.createElement('a');
        const tokenParam = chatToken ? `?chat_token=${encodeURIComponent(chatToken)}` : '';
        link.href = `${file.file_url}${tokenParam}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = `${file.original_name} (${Math.ceil((file.size_bytes || 0) / 1024)} KB)`;
        filesWrap.appendChild(link);
      });
      bubble.appendChild(filesWrap);
    }

    const time = document.createElement('small');
    time.className = 'chat-bubble-time';
    const createdAt = msg.created_at ? new Date(msg.created_at) : new Date();
    time.textContent = createdAt.toLocaleString('de-DE');
    bubble.appendChild(time);

    messagesEl.appendChild(bubble);
  }

  function renderMessages(messages) {
    messagesEl.innerHTML = '';
    if (!Array.isArray(messages) || messages.length === 0) {
      const empty = document.createElement('article');
      empty.className = 'chat-bubble admin';
      empty.textContent = 'Hallo! Wie können wir Ihnen helfen?';
      messagesEl.appendChild(empty);
      return;
    }

    messages.forEach(appendMessageBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function ensureChatSession() {
    if (chatId && chatToken) return;

    const response = await fetch('/api/chat/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfInput.value,
      },
      body: JSON.stringify({
        source_page: sourceInput ? sourceInput.value : window.location.pathname,
      }),
    });

    if (!response.ok) {
      throw new Error('Chat konnte nicht gestartet werden.');
    }

    const data = await response.json();
    chatId = data.chat_id;
    chatToken = data.chat_token;
    saveSession();
  }

  async function fetchMessages() {
    if (!chatId || !chatToken) return;
    const response = await fetch(
      `/api/chat/${encodeURIComponent(chatId)}/messages?chat_token=${encodeURIComponent(chatToken)}`,
      { method: 'GET' }
    );

    if (response.status === 401 || response.status === 404) {
      clearSession();
      return;
    }

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    renderMessages(data.messages || []);
  }

  async function postMessageWithCurrentSession(formData) {
    return fetch(`/api/chat/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: formData,
    });
  }

  async function sendMessage(event) {
    event.preventDefault();

    const text = (messageInput.value || '').trim();
    const files = fileInput.files;
    if (!text && (!files || files.length === 0)) {
      return;
    }

    try {
      await ensureChatSession();
      const formData = new FormData();
      formData.append('_csrf', csrfInput.value);
      formData.append('chat_token', chatToken);
      if (text) {
        formData.append('message', text);
      }
      if (files && files.length > 0) {
        for (let i = 0; i < Math.min(files.length, 3); i += 1) {
          formData.append('files', files[i]);
        }
      }

      let response = await postMessageWithCurrentSession(formData);

      // If token/session became stale (e.g. server restart), reset and retry once.
      if (response.status === 401 || response.status === 404) {
        clearSession();
        await ensureChatSession();
        formData.set('chat_token', chatToken);
        response = await postMessageWithCurrentSession(formData);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Nachricht konnte nicht gesendet werden.');
      }

      const data = await response.json();
      messageInput.value = '';
      fileInput.value = '';
      updateFileLabel();
      renderMessages(data.messages || []);
    } catch (_err) {
      const errorBubble = document.createElement('article');
      errorBubble.className = 'chat-bubble admin';
      errorBubble.textContent = 'Senden fehlgeschlagen. Bitte erneut versuchen.';
      messagesEl.appendChild(errorBubble);
    }
  }

  function startPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    pollTimer = setInterval(fetchMessages, 8000);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function openPanel() {
    panel.classList.add('open');
    try {
      await ensureChatSession();
      await fetchMessages();
    } catch (_err) {
      renderMessages([]);
    }
    startPolling();
  }

  function closePanel() {
    panel.classList.remove('open');
    stopPolling();
  }

  launcher.addEventListener('click', () => {
    if (panel.classList.contains('open')) {
      closePanel();
    } else {
      openPanel();
    }
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closePanel);
  }

  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', updateFileLabel);
    updateFileLabel();
  }

  form.addEventListener('submit', sendMessage);
  loadSession();
})();

(function initMobileMenu() {
  const headerMain = document.querySelector('.header-main');
  const toggle = document.querySelector('.header-main .sidebar__toggle');
  if (!headerMain || !toggle) {
    return;
  }

  const closeMenu = () => headerMain.classList.remove('mobile-menu-open');

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    headerMain.classList.toggle('mobile-menu-open');
  });

  document.querySelectorAll('.header-main .main-menu a').forEach((link) => {
    link.addEventListener('click', closeMenu);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1199) {
      closeMenu();
    }
  });
})();

(function initSubtleReveal() {
  const revealItems = Array.from(document.querySelectorAll('.subtle-reveal'));
  if (revealItems.length === 0) {
    return;
  }
  document.documentElement.classList.add('js-reveal');

  revealItems.forEach((el) => {
    const rawDelay = Number(el.getAttribute('data-reveal-delay') || 0);
    const safeDelay = Number.isFinite(rawDelay) ? Math.max(0, rawDelay) : 0;
    el.style.setProperty('--reveal-delay', `${safeDelay}ms`);
  });

  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      });
    },
    { root: null, rootMargin: '0px 0px -8% 0px', threshold: 0.15 }
  );

  revealItems.forEach((el) => observer.observe(el));
})();
