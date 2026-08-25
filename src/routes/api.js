const express = require('express');
const multer = require('multer');
const manager = require('../whatsapp/manager');

const router = express.Router();

// Parses multipart/form-data bodies (fields only) for form-based endpoints
const multipartFields = multer().none();
const mediaUpload = multer({ limits: { fileSize: 16 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// 1. LOGIN WITH WHATSAPP (QR)
// ---------------------------------------------------------------------------

/**
 * POST /api/login
 */
router.post('/login', async (req, res) => {
  try {
    const phone = req.get('phone');
    console.info(`[api] Login requested${phone ? ' with pairing code' : ' with QR'}.`);

    if (manager.status === 'ready' || manager.status === 'authenticated') {
      console.info(`[api] Login check complete: client is ${manager.status}.`);
      return res.json({
        success: true,
        status: manager.status,
        qr: null,
        code: null,
        message: 'Already logged in.',
      });
    }

    if (!manager.qrPng) {
      // Trigger initialization if not started yet
      if (!manager.client) manager.initialize();
      console.info(`[api] Login pending: QR is not available yet (status: ${manager.status}).`);
      return res.json({
        success: true,
        status: manager.status,
        qr: null,
        code: null,
        message: 'QR not generated yet. Retry in a few seconds.',
      });
    }

    const qrUrl = `${req.protocol}://${req.get('host')}/api/login/qr/${manager.qrId}.png`;

    // No phone header → QR-only login
    if (!phone) {
      console.info('[api] QR login URL returned.');
      return res.json({
        success: true,
        status: manager.status,
        qr: qrUrl,
        note: 'Scan the QR with WhatsApp -> Linked Devices. QR expires within 60 seconds — POST again for a fresh one.',
      });
    }

    // Phone header present → also generate an 8-digit pairing code.
    // If requests come too frequently, the manager returns the recent code
    // instead of requesting a new one (avoids WhatsApp rate limits).
    const result = await manager.requestPairingCode(phone);
    console.info(`[api] Pairing code returned${result.reused ? ' from cache' : ''}.`);

    res.json({
      success: true,
      status: manager.status,
      qr: qrUrl,
      code: result.code,
      reused: result.reused,
      note: result.reused
        ? 'Returned the recent pairing code to avoid rate limits. Enter it on your phone now.'
        : 'QR and pairing code expire within 60 seconds. POST again for fresh ones.',
    });
  } catch (err) {
    console.error('[api] Login failed:', err.message);
    const httpCode = err.statusCode || 500;
    res.status(httpCode).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/login/qr/:id.png
 * Returns the QR code as a raw PNG image — usable directly as an <img src>.
 * The :id changes every time the QR rotates, so URLs are always fresh.
 */
router.get('/login/qr/:file', (req, res) => {
  const valid = manager.qrPng && req.params.file === `${manager.qrId}.png`;
  if (!valid) {
    console.warn(`[api] QR request rejected for id ${req.params.file}.`);
    return res.status(404).json({
      success: false,
      error: 'No QR available for this id. Fetch GET /api/login for the current one.',
      status: manager.status,
    });
  }
  res.type('png').send(manager.qrPng);
  console.info('[api] QR image served.');
});

/**
 * POST /api/logout
 * Phone is passed in the 'phone' header and must match the currently
 * logged-in account — otherwise the logout is rejected.
 * Logs out and clears the saved session.
 */
router.post('/logout', async (req, res) => {
  try {
    const phone = req.get('phone');
    const force = req.query.force === 'true' || req.get('x-force-logout') === 'true';
    if (!phone) {
      if (force) {
        await manager.logout();
        console.info('[api] Forced WhatsApp logout completed.');
        return res.json({ success: true, message: 'Logged out. Persisted session cleared.' });
      }
      return res.status(400).json({
        success: false,
        error: '"phone" header is required. Example: phone: 919641114583',
      });
    }

    if (manager.status !== 'ready' && manager.status !== 'authenticated') {
      return res.status(409).json({
        success: false,
        status: manager.status,
        error: 'Not logged in. Nothing to log out from.',
      });
    }

    // Only allow logout when the phone matches the logged-in account
    const requestDigits = phone.replace(/\D/g, '');
    const loggedInDigits = (manager.loggedInNumber || '').replace(/\D/g, '');
    if (!force && (!loggedInDigits || requestDigits !== loggedInDigits)) {
      return res.status(403).json({
        success: false,
        error: 'Credential error. Logout refused.',
      });
    }

    await manager.logout();
    console.info('[api] WhatsApp session logged out.');
    res.json({ success: true, message: `Logged out (${requestDigits}). Session cleared.` });
  } catch (err) {
    console.error('[api] Logout failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/login/restart
 * Restarts the WhatsApp client (useful after disconnect).
 */
router.post('/login/restart', (req, res) => {
  try {
    manager.restart();
    console.info('[api] WhatsApp client restart requested.');
    res.json({ success: true, message: 'Client restarting...' });
  } catch (err) {
    console.error('[api] Client restart failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. SEND MESSAGE
// ---------------------------------------------------------------------------

/**
 * POST /api/messages/send
 * Accepts multipart/form-data, application/x-www-form-urlencoded, or JSON.
 * Fields:
 *   to      - phone number with country code or full chat id
 *   message  - message text or URL
 *   media    - optional media file
 *   mediaUrl - optional publicly accessible media URL
 *   caption  - optional caption for media
 */
router.post('/messages/send', mediaUpload.single('media'), async (req, res) => {
  try {
    const body = req.body || {};
    const to = body.to;
    const message = body.message;
    const mediaUrl = body.mediaUrl;
    const caption = body.caption || '';

    if (!to || (!message && !req.file && !mediaUrl)) {
      return res.status(400).json({
        success: false,
        error: '"to" and one of "message", "media", or "mediaUrl" are required.',
      });
    }
    const result = await manager.sendMessage(to, message, {
      file: req.file || null,
      mediaUrl,
      caption,
    });
    console.info(`[api] Message sent to ${result.chatId}.`);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[api] Message send failed:', err.message);
    const code = err.statusCode || 500;
    res.status(code).json({
      success: false,
      error: err.message,
      status: manager.status,
      loggedInNumber: manager.loggedInNumber,
    });
  }
});

/**
 * GET /api/chats/history?chat=911234567890&limit=50
 * Returns recent messages for a chat.
 */
const chatHistoryHandler = async (req, res) => {
  try {
    const chat = req.body?.chat ?? req.query.chat;
    const requestedLimit = req.body?.limit ?? req.query.limit;
    if (!chat) {
      return res.status(400).json({ success: false, error: '"chat" is required in the request body.' });
    }
    const parsedLimit = Math.min(Math.max(parseInt(requestedLimit, 10) || 50, 1), 200);
    const history = await manager.getChatHistory(chat, parsedLimit);
    console.info(`[api] Chat history requested for ${history.chatId}.`);
    res.json({ success: true, data: history });
  } catch (err) {
    console.error('[api] Chat history request failed:', err.message);
    const code = err.statusCode || 500;
    res.status(code).json({ success: false, error: err.message });
  }
};

router.get('/chats/history', multipartFields, chatHistoryHandler);
router.post('/chats/history', multipartFields, chatHistoryHandler);

/**
 * GET /api/chats?limit=50
 * Lists all chats (id, name, unread count, last message).
 */
const listChatsHandler = async (req, res) => {
  try {
    const requestedLimit = req.body?.limit ?? req.query.limit;
    const limit = Math.min(Math.max(parseInt(requestedLimit, 10) || 50, 1), 200);
    const chats = await manager.listChats(limit);
    console.info(`[api] Chat list requested (${chats.length} returned).`);
    res.json({ success: true, data: chats });
  } catch (err) {
    console.error('[api] Chat list request failed:', err.message);
    const code = err.statusCode || 500;
    res.status(code).json({ success: false, error: err.message });
  }
};

router.get('/chats', multipartFields, listChatsHandler);
router.post('/chats', multipartFields, listChatsHandler);

// ---------------------------------------------------------------------------
// 5. HEALTH STATUS (CONNECTION STATUS)
// ---------------------------------------------------------------------------

/**
 * GET /api/health
 * Returns connection status of the WhatsApp client.
 */
router.get('/health', (req, res) => {
  const health = manager.getHealth();
  const httpStatus = health.connected ? 200 : 503;
  res.status(httpStatus).json({ success: health.connected, data: health });
});

/**
 * GET /api/info
 * Returns the current WhatsApp account, connection, process, and webhook info.
 */
router.get('/info', (req, res) => {
  const health = manager.getHealth();
  res.json({
    success: true,
    data: {
      phone: health.loggedInNumber,
      status: health.status,
      connected: health.connected,
      uptimeSeconds: health.uptimeSeconds,
      readyAt: health.readyAt,
      webhookUrl: manager.webhookUrl,
      timestamp: health.timestamp,
    },
  });
});

module.exports = router;
