const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * WhatsApp connection manager.
 * Handles client lifecycle, QR login, session persistence,
 * incoming message events, and webhook dispatch.
 */
class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'disconnected'; // disconnected | initializing | qr_ready | authenticated | ready | failed
    this.qrDataUrl = null; // QR as base64 data URL for easy display in browsers
    this.qrRaw = null; // Raw QR string (for terminal or custom rendering)
    this.qrPng = null; // QR as PNG buffer
    this.qrId = null; // Unique id for the current QR (used in the PNG url)
    this.pairingCode = null; // 8-digit code for phone-number linking
    this._pairingCodeAt = 0; // Timestamp of when the current pairing code was generated
    this._pairingInProgress = false; // Guards against concurrent pairing requests
    this.lastError = null;
    this.readyAt = null;
    this.loggedInNumber = null; // Phone number (digits) of the currently logged-in account
    this.webhookConfigPath = path.resolve(process.env.WEBHOOK_CONFIG_FILE || './.webhook.json');
    this.webhookUrl = this._loadWebhookUrl() || process.env.WEBHOOK_URL || null;
  }

  _loadWebhookUrl() {
    try {
      const config = JSON.parse(fs.readFileSync(this.webhookConfigPath, 'utf8'));
      return typeof config.url === 'string' ? config.url : null;
    } catch (_) {
      return null;
    }
  }

  _saveWebhookUrl() {
    if (this.webhookUrl) {
      fs.writeFileSync(this.webhookConfigPath, JSON.stringify({ url: this.webhookUrl }, null, 2));
    } else {
      try {
        fs.unlinkSync(this.webhookConfigPath);
      } catch (_) {
        /* file already absent */
      }
    }
  }

  setWebhookUrl(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS URLs are supported.');
      this.webhookUrl = parsed.toString();
    } catch (err) {
      const error = new Error(`Invalid webhook URL: ${err.message}`);
      error.statusCode = 400;
      throw error;
    }
    this._saveWebhookUrl();
    return this.webhookUrl;
  }

  clearWebhookUrl() {
    this.webhookUrl = null;
    this._saveWebhookUrl();
  }

  initialize() {
    if (this.client) return;

    this._setStatus('initializing');

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: process.env.SESSION_DIR || './.wwebjs_auth',
      }),
      // Pin a known-good WhatsApp Web build. The library's injected code must
      // match the page internals — unpinned versions break (minified errors
      // like "r"/"t") whenever WhatsApp ships a UI update.
      // The wa-version repo now publishes only "-alpha"-suffixed names; the
      // latest one is the current stable WA Web build.
      webVersion: '2.3000.1045849355-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1045849355-alpha.html',
      },
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    });

    // ---- Lifecycle events ----

    this.client.on('qr', async (qr) => {
      this.qrRaw = qr;
      this.qrDataUrl = await qrcode.toDataURL(qr);
      this.qrPng = await qrcode.toBuffer(qr, { type: 'png' });
      this.qrId = crypto.randomBytes(4).toString('hex'); // e.g. "3fa2b81c"
      this._setStatus('qr_ready');
      console.log('[wa] QR code generated. Scan it with WhatsApp -> Linked Devices.');
    });

    this.client.on('authenticated', () => {
      this.pairingCode = null;
      this._setStatus('authenticated');
      console.log('[wa] Authenticated.');
    });

    this.client.on('auth_failure', (msg) => {
      this.lastError = msg;
      this._setStatus('failed');
      console.error('[wa] Authentication failure:', msg);
    });

    this.client.on('ready', () => {
      this.readyAt = new Date().toISOString();
      this.qrDataUrl = null;
      this.qrRaw = null;
      this.qrPng = null;
      this.qrId = null;
      this.pairingCode = null;
      // Remember which account is logged in (digits only, e.g. "919641114583")
      const loggedInUser = this.client.info?.wid?.user;
      this.loggedInNumber = loggedInUser ? String(loggedInUser).replace(/\D/g, '') : null;
      this._setStatus('ready');
      console.log(`[wa] Client is ready. Logged in as +${this.loggedInNumber || 'unknown'}.`);
    });

    this.client.on('disconnected', (reason) => {
      this.readyAt = null;
      this.pairingCode = null;
      this._pairingCodeAt = 0;
      this.loggedInNumber = null;
      this._setStatus('disconnected');
      console.warn('[wa] Client disconnected:', reason);
      // Reset so a fresh initialize() can be attempted
      this.client = null;
    });

    // ---- Incoming messages: emit locally + forward to webhook ----
    this.client.on('message', async (msg) => {
      const payload = {
        event: 'message.received',
        id: msg.id._serialized,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        isGroupMsg: msg.isStatus ? false : msg.from.endsWith('@g.us'),
        createdAt: new Date().toISOString(),
      };
      console.info(`[wa] Message received from ${msg.from}.`);
      this.emit('message', payload);
      await this._forwardWebhook(payload);
    });

    // Acknowledgment events (sent, delivered, read, played)
    this.client.on('message_ack', (msg, ack) => {
      const ackNames = { 0: 'pending', 1: 'server', 2: 'delivered', 3: 'read', 4: 'played' };
      const payload = {
        event: 'message.ack',
        id: msg.id._serialized,
        ack: ackNames[ack] || String(ack),
        timestamp: new Date().toISOString(),
      };
      console.info(`[wa] Message acknowledgement: ${payload.ack} (${payload.id}).`);
      this.emit('message_ack', payload);
      this._forwardWebhook(payload).catch(() => {});
    });

    // Connection status changes (device connected/disconnected) — emit + forward
    this.on('status_change', async (payload) => {
      await this._forwardWebhook({ event: 'connection.status', ...payload }).catch(() => {});
    });

    this.client.initialize().catch((err) => {
      this.lastError = err.message;
      this._setStatus('failed');
      console.error('[wa] Failed to initialize client:', err.message);
    });
  }

  /**
   * Request an 8-character pairing code ("Link with phone number" flow).
   * The code must be entered on the phone within ~1 minute.
   * @param {string} phoneNumber - Your WhatsApp number with country code, digits only
   * @returns {Promise<string>} e.g. "ABCD-1234"
   */
  async requestPairingCode(phoneNumber) {
    if (this.status === 'ready' || this.status === 'authenticated') {
      const err = new Error('Already logged in.');
      err.statusCode = 409;
      throw err;
    }
    if (!this.client) this.initialize();

    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits || digits.length < 8) {
      const err = new Error(`Invalid phone number: "${phoneNumber}". Use digits with country code, e.g. 911234567890`);
      err.statusCode = 400;
      throw err;
    }

    // Wait until the client can issue a pairing code (needs to reach the auth screen)
    const waitUntil = (predicate, timeoutMs) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (predicate()) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error('Timed out waiting for client to be ready for pairing.'));
          }
        }, 500);
      });

    await waitUntil(
      () => ['qr_ready', 'authenticated', 'ready'].includes(this.status),
      60000
    );

    // Prevent concurrent pairing requests — a second call while one is in
    // flight corrupts the auth screen state and makes the client throw.
    if (this._pairingInProgress) {
      const err = new Error('A pairing code was just requested. Wait ~60s for it to expire, then retry.');
      err.statusCode = 429;
      throw err;
    }

    this._pairingInProgress = true;
    try {
      // Rate-limit protection: WhatsApp blocks numbers that request pairing
      // codes too often (CompanionHelloError / IQErrorRateOverlimit). If a
      // recent code still exists, return it instead of requesting a new one.
      const CODE_TTL_MS = 60000; // codes are valid ~60s on the phone
      const COOLDOWN_MS = 20000; // min gap between real requests to WhatsApp
      const age = Date.now() - this._pairingCodeAt;
      if (this.pairingCode && age < CODE_TTL_MS) {
        console.log(`[wa] Returning recent pairing code (${Math.round(age / 1000)}s old) instead of requesting a new one.`);
        return { code: this.pairingCode, reused: true, expiresInMs: CODE_TTL_MS - age };
      }
      if (age < COOLDOWN_MS) {
        const waitMs = COOLDOWN_MS - age;
        console.log(`[wa] Cooling down ${waitMs}ms before requesting a new pairing code...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }

      const maxAttempts = 2;
      let lastErr = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // The QR renders BEFORE the WebSocket finishes connecting. Calling
          // requestPairingCode while the socket is still OPENING makes
          // startAltLinkingFlow throw internally (minified as "t").
          // So always wait until the socket reports an unpaired state.
          await this._waitForPairableSocket(60000);
          const code = await this._generatePairingCode(digits);
          this._pairingCodeAt = Date.now();
          return { code, reused: false, expiresInMs: CODE_TTL_MS };
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) {
            console.warn(`[wa] Pairing attempt ${attempt}/${maxAttempts} failed:`, err && err.message);
            // Full restart: a failed attempt leaves WhatsApp Web in a bad
            // state that only a fresh browser fixes.
            await this.restart();
            await waitUntil(() => this.status === 'qr_ready', 60000);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      }

      console.error('[wa] All pairing attempts failed. Last error:', lastErr && lastErr.stack ? lastErr.stack : lastErr);

      // Rate-limited by WhatsApp? If we still have an unexpired-ish code,
      // hand that back rather than failing outright.
      if (this.pairingCode && Date.now() - this._pairingCodeAt < 180000) {
        console.warn('[wa] Request failed but returning the previous pairing code as fallback.');
        return { code: this.pairingCode, reused: true, expiresInMs: 0 };
      }

      const friendly = new Error(
        'Failed to generate pairing code. WhatsApp may be rate-limiting this number — wait a few minutes and use QR login meanwhile.'
      );
      friendly.statusCode = 429;
      throw friendly;
    } finally {
      this._pairingInProgress = false;
    }
  }

  /**
   * Waits until the WhatsApp Web socket reaches a state that accepts
   * pairing-code requests (UNPAIRED or UNPAIRED_IDLE). The QR appears
   * before the socket finishes connecting, so this gate is essential.
   */
  async _waitForPairableSocket(timeoutMs) {
    const started = Date.now();
    let lastState = 'unknown';
    while (Date.now() - started < timeoutMs) {
      try {
        lastState = await this.client.getState();
        // null = auth screen, not connected yet — pairable
        if (lastState === null || lastState === 'UNPAIRED' || lastState === 'UNPAIRED_IDLE') {
          return;
        }
      } catch (_) {
        lastState = 'page-not-ready';
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Socket never became pairable (last state: ${lastState}).`);
  }

  /**
   * Single attempt to generate a pairing code against the current client.
   * Throws the raw error on failure (caller handles retries/logging).
   */
  async _generatePairingCode(digits) {
    const code = await this.client.requestPairingCode(digits);
    // Format as XXXX-XXXX for readability
    this.pairingCode = code.match(/.{1,4}/g).join('-');
    console.log(`[wa] Pairing code: ${this.pairingCode}`);
    return this.pairingCode;
  }

  /** Restart the client (e.g., after logout/disconnect). Fully tears down the old instance first. */
  async restart() {
    // Keep a local reference: destroy() can fire 'disconnected', whose
    // handler nulls this.client mid-teardown.
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.destroy();
      } catch (err) {
        console.warn('[wa] Error during client destroy:', err && err.message);
      }
    }
    this.initialize();
  }

  /** Logout and wipe the saved session */
  async logout() {
    // IMPORTANT: keep a local reference. client.logout() triggers the
    // 'disconnected' event, whose handler sets this.client = null — using
    // this.client afterwards would skip destroy() and leak the browser.
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.logout();
      } catch (_) {
        /* ignore */
      }
      try {
        await client.destroy();
      } catch (_) {
        /* ignore */
      }
    }
    this.readyAt = null;
    this.pairingCode = null;
    this._pairingCodeAt = 0;
    this.loggedInNumber = null;
    this._setStatus('disconnected');
  }

  /**
  * Send a text or media message.
   * @param {string} chatId - Phone number (digits, with country code) or full chat id (e.g. 1234@c.us)
  * @param {string} message - Message body or URL
  * @param {object} options - Optional uploaded file, media URL, and caption
   */
  async sendMessage(chatId, message, options = {}) {
    await this._ensureReady();

    let target;
    if (chatId.includes('@')) {
      target = chatId; // already a chat id (xxx@c.us / xxx@g.us)
    } else {
      // Resolve the phone number to a valid WhatsApp id
      const digits = chatId.replace(/\D/g, '');
      if (!digits || digits.length < 8) {
        const err = new Error(`Invalid phone number: "${chatId}". Use digits with country code, e.g. 911234567890`);
        err.statusCode = 400;
        throw err;
      }
      const numberId = await this.client.getNumberId(digits);
      if (!numberId) {
        const err = new Error(
          `Number "${digits}" is not registered on WhatsApp. Check the country code and number.`
        );
        err.statusCode = 404;
        throw err;
      }
      target = numberId._serialized;
    }

    let content = message;
    let sendOptions;
    if (options.file || options.mediaUrl) {
      let media;
      if (options.file) {
        media = new MessageMedia(
          options.file.mimetype,
          options.file.buffer.toString('base64'),
          options.file.originalname
        );
      } else {
        try {
          media = await MessageMedia.fromUrl(options.mediaUrl);
        } catch (err) {
          console.warn(`[wa] Media URL is not directly downloadable; sending as a text link: ${options.mediaUrl}`);
          content = options.mediaUrl;
        }
      }
      if (media) {
        content = media;
        sendOptions = { caption: options.caption || '' };
      }
    }

    const sent = await this.client.sendMessage(target, content, sendOptions);

    // Some chats (especially @lid ids) do not return a message ID even though
    // delivery succeeded. Try the local store, but keep the send successful.
    let msgId = sent && sent.id ? sent.id._serialized || sent.id.id || sent.id : null;
    if (!msgId) {
      console.info(`[wa] Message delivered to ${target}; no message id was returned, attempting local recovery...`);
      for (const delay of [300, 800, 1500]) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          const chat = await this._findChatInStore(target);
          const [last] = chat ? await chat.fetchMessages({ limit: 1 }) : [];
          if (last && last.fromMe) {
            msgId = last.id._serialized;
            break;
          }
        } catch (_) {
          /* retry */
        }
      }
      if (!msgId) console.info(`[wa] Message id unavailable for ${target}; returning the successful delivery without an id.`);
    }

    // `to` = the phone number as given; `chatId` = WhatsApp's resolved internal id
    const digitsOnly = chatId.replace(/\D/g, '');
    return {
      id: msgId,
      to: chatId.includes('@') ? target : digitsOnly,
      chatId: target,
      body: (sent && sent.body) || message || options.caption || null,
      timestamp: (sent && sent.timestamp) || Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Get chat history (messages) for a chat.
   * @param {string} chatId - Phone number or chat id
   * @param {number} limit - Max messages to fetch
   */
  async getChatHistory(chatId, limit = 50) {
    await this._ensureReady();
    let formatted = this.formatChatId(chatId);

    if (!chatId.includes('@')) {
      const digits = chatId.replace(/\D/g, '');
      const numberId = await this.client.getNumberId(digits);
      if (!numberId) {
        const err = new Error(`Number "${digits}" is not registered on WhatsApp.`);
        err.statusCode = 404;
        throw err;
      }
      formatted = numberId._serialized;
    }

    let chat;
    try {
      chat = await this.client.getChatById(formatted);
    } catch (err) {
      // getChatById uses findOrCreateLatestChat internally, which throws
      // (minified "r") on current WA Web builds. Fall back to searching the
      // already-loaded chat store instead of creating a new chat entry.
      console.warn(`[wa] getChatById(${formatted}) failed (${err && err.message}), falling back to store lookup...`);
      chat = await this._findChatInStore(formatted);
    }
    if (!chat) throw new Error(`Chat not found: ${formatted}`);
    let messages;
    try {
      messages = await chat.fetchMessages({ limit });
    } catch (err) {
      console.error(`[wa] fetchMessages(${formatted}) failed:`, err && err.stack ? err.stack : err);
      const friendly = new Error(
        `Could not fetch messages for ${formatted}. The WhatsApp page may need a restart — try POST /api/login/restart.`
      );
      friendly.statusCode = 503;
      throw friendly;
    }
    messages = messages.filter((message) => this.hasMessageContent(message));
    return {
      chatId: formatted,
      name: chat.name || null,
      messageCount: messages.length,
      messages: messages.map((m) => ({
        id: typeof m.id === 'string' ? m.id : m.id?._serialized || null,
        from: m.from,
        to: m.to,
        body: m.body,
        fromMe: m.fromMe,
        hasMedia: m.hasMedia,
        timestamp: m.timestamp,
        type: m.type,
      })),
    };
  }

  /** List all chats (useful companion to history) */
  async listChats(limit = 50) {
    await this._ensureReady();
    try {
      const chats = await this.client.pupPage.evaluate(() => {
        const chatCollection = window.require('WAWebCollections').Chat;
        const models = typeof chatCollection.getModelsArray === 'function'
          ? chatCollection.getModelsArray()
          : chatCollection.models || [];
        return models.map((chat) => {
          let lastMessage = chat.lastMessage || null;
          if (!lastMessage) {
            const messageCollection = chat.msgs;
            const messages = messageCollection
              ? (typeof messageCollection.getModelsArray === 'function'
                ? messageCollection.getModelsArray()
                : messageCollection.models || [])
              : [];
            lastMessage = messages
              .slice()
              .reverse()
              .find((message) => message && message.body !== null && message.body !== undefined
                && !['e2e_notification', 'notification', 'protocol'].includes(message.type)) || null;
          }
          return {
            id: chat.id && chat.id._serialized,
            name: chat.name || chat.contact?.pushname || null,
            unreadCount: chat.unreadCount || 0,
            lastMessage: lastMessage?.body ?? null,
            timestamp: chat.t || lastMessage?.t || null,
          };
        }).filter((chat) => chat.id);
      });
      return chats.slice(0, limit);
    } catch (err) {
      console.error('[wa] chat store lookup failed:', err && err.stack ? err.stack : err);
      const friendly = new Error(
        'Could not list chats. The WhatsApp page may need a restart — try POST /api/login/restart.'
      );
      friendly.statusCode = 503;
      throw friendly;
    }
  }

  /**
   * Look up a chat in the already-loaded WhatsApp store without triggering
   * findOrCreateLatestChat (which throws on current WA Web builds).
   * Returns a lightweight Chat-like object or null.
   */
  async _findChatInStore(chatId) {
    try {
      const raw = await this.client.pupPage.evaluate(async (id) => {
        const wid = window.require('WAWebWidFactory').createWid(id);
        const chat = window.require('WAWebCollections').Chat.get(wid);
        if (!chat) return null;
        const messageCollection = chat.msgs;
        const msgs = messageCollection
          ? (typeof messageCollection.getModelsArray === 'function'
            ? messageCollection.getModelsArray()
            : messageCollection.models || [])
          : [];
        return {
          id: chat.id._serialized,
          name: chat.name || chat.contact?.pushname || null,
          msgs: msgs.map((m) => ({
            id: m.id && (m.id._serialized || String(m.id)) || null,
            from: m.from && (m.from._serialized || String(m.from)) || null,
            to: m.to && (m.to._serialized || String(m.to)) || null,
            body: m.body || null,
            fromMe: !!m.id && m.id.fromMe,
            hasMedia: !!m.isMedia || !!m.mimetype,
            timestamp: m.t,
            type: m.type,
          })),
        };
      }, chatId);
      if (!raw) return null;
      // Wrap into the shape getChatHistory expects
      return {
        id: { _serialized: raw.id },
        name: raw.name,
        fetchMessages: async ({ limit }) => raw.msgs
          .filter((message) => message.id && this.hasMessageContent(message))
          .slice(-limit)
          .reverse(),
      };
    } catch (err) {
      console.warn(`[wa] store lookup for ${chatId} failed:`, err && err.message);
      return null;
    }
  }

  /** Format user input into a WhatsApp chat id */
  formatChatId(input) {
    if (input.includes('@')) return input; // already a chat id (xxx@c.us / xxx@g.us)
    const digits = input.replace(/\D/g, '');
    if (!digits) throw new Error(`Invalid phone number: ${input}`);
    return `${digits}@c.us`;
  }

  hasMessageContent(message) {
    return message && message.body !== null && message.body !== undefined
      && !['e2e_notification', 'notification', 'protocol'].includes(message.type);
  }

  /** Health snapshot of the connection */
  getHealth() {
    return {
      status: this.status,
      connected: this.status === 'ready',
      loggedInNumber: this.loggedInNumber,
      readyAt: this.readyAt,
      hasQr: Boolean(this.qrDataUrl),
      lastError: this.lastError,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status_change', { status, timestamp: new Date().toISOString() });
  }

  async _ensureReady() {
    if (this.status === 'ready') return;

    if (this.status === 'authenticated') {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(this._notReadyError());
        }, 15000);
        const onStatusChange = ({ status }) => {
          if (status === 'ready') {
            cleanup();
            resolve();
          } else if (status === 'failed' || status === 'disconnected') {
            cleanup();
            reject(this._notReadyError());
          }
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.off('status_change', onStatusChange);
        };
        this.on('status_change', onStatusChange);
      });
      return;
    }

    throw this._notReadyError();
  }

  _notReadyError() {
    const message = this.status === 'qr_ready'
      ? 'WhatsApp client is waiting for QR login. Scan the QR code first via GET /api/login/qr'
      : `WhatsApp client not ready (status: ${this.status}).`;
    const err = new Error(message);
    err.statusCode = 409;
    return err;
  }

  /** POST payload to configured webhook URL (fire-and-forget) */
  async _forwardWebhook(payload) {
    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.warn(`[wa] Webhook delivery failed (${res.status}) to ${this.webhookUrl}`);
      }
    } catch (err) {
      console.warn('[wa] Webhook delivery error:', err.message);
    }
  }
}

// Singleton instance shared across the app
module.exports = new WhatsAppManager();
