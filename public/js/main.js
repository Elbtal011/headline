(function initChatWidget() {
  const launcher = document.getElementById('chat-launcher');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.getElementById('chat-close');
  const form = document.getElementById('chat-form');
  const messageInput = document.getElementById('chat-message-input');
  const fileBtn = document.getElementById('chat-file-btn');
  const fileLabel = document.getElementById('chat-file-label');
  const messagesEl = document.getElementById('chat-messages');

  if (!launcher || !panel || !form || !messagesEl) return;

  const API_BASE = String(window.MAGICVICS_API_BASE || '').replace(/\/$/, '');
  const STORAGE_KEY = 'mv_guest_chat_v1';
  const USER_KEY = 'mv_guest_user_v1';

  let conversationId = null;
  let pollTimer = null;

  function ensureGuestUserId() {
    let uid = localStorage.getItem(USER_KEY);
    if (!uid) {
      uid = `guest_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(USER_KEY, uid);
    }
    return uid;
  }

  function loadSession() {
    conversationId = localStorage.getItem(STORAGE_KEY) || null;
  }

  function saveSession() {
    if (conversationId) localStorage.setItem(STORAGE_KEY, conversationId);
  }

  function appendMessageBubble(msg) {
    const bubble = document.createElement('article');
    bubble.className = `chat-bubble ${msg.sender_type === 'user' ? 'visitor' : 'admin'}`;

    const text = document.createElement('div');
    text.textContent = msg.content || '(leer)';
    bubble.appendChild(text);

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

  async function ensureConversation() {
    if (conversationId) return;
    const userId = ensureGuestUserId();
    const response = await fetch(`${API_BASE}/api/chat/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, title: 'Headline Website Chat', conversationType: 'general' }),
    });
    if (!response.ok) throw new Error('Chat konnte nicht gestartet werden.');
    const data = await response.json();
    conversationId = data.conversation?.id || data.data?.id || null;
    if (!conversationId) throw new Error('Keine Konversation-ID erhalten.');
    saveSession();
  }

  async function fetchMessages() {
    if (!conversationId) return;
    const response = await fetch(`${API_BASE}/api/chat/conversations/${encodeURIComponent(conversationId)}/messages?limit=100`, {
      method: 'GET',
    });
    if (!response.ok) return;
    const data = await response.json();
    renderMessages(data.messages || []);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = (messageInput.value || '').trim();
    if (!text) return;

    try {
      await ensureConversation();
      const userId = ensureGuestUserId();
      const response = await fetch(`${API_BASE}/api/chat/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, userId, content: text }),
      });

      if (!response.ok) throw new Error('Nachricht konnte nicht gesendet werden.');
      messageInput.value = '';
      await fetchMessages();
    } catch (_err) {
      const errorBubble = document.createElement('article');
      errorBubble.className = 'chat-bubble admin';
      errorBubble.textContent = 'Senden fehlgeschlagen. Bitte erneut versuchen.';
      messagesEl.appendChild(errorBubble);
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
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
      await ensureConversation();
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
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });

  if (closeBtn) closeBtn.addEventListener('click', closePanel);
  if (fileBtn) fileBtn.addEventListener('click', (e) => e.preventDefault());
  if (fileLabel) fileLabel.textContent = 'Textchat aktiv';

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
