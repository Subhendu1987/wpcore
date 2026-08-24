require('dotenv').config();
const express = require('express');
const util = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const whatsappManager = require('./whatsapp/manager');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error('API_KEY must be set in the environment or .env file.');
}
const logHistory = [];
const logClients = new Set();
const logSessions = new Map();
const postmanCollectionPath = path.resolve(__dirname, '../postman/wpcore.postman_collection.json');

function createPostmanCollection(baseUrl, includeApiKey = true) {
  const collection = JSON.parse(fs.readFileSync(postmanCollectionPath, 'utf8'));
  const variables = Array.isArray(collection.variable) ? collection.variable : [];
  const baseUrlVariable = variables.find((variable) => variable.key === 'baseUrl');
  const apiKeyVariable = variables.find((variable) => variable.key === 'apiKey');
  const phoneVariable = variables.find((variable) => variable.key === 'phone');
  const chatIdVariable = variables.find((variable) => variable.key === 'chatId');
  const previousBaseUrl = baseUrlVariable && baseUrlVariable.value;
  const previousApiKey = apiKeyVariable && apiKeyVariable.value;

  const replaceValues = (value) => {
    if (typeof value === 'string') {
      let updated = value;
      if (previousBaseUrl) updated = updated.replaceAll(previousBaseUrl, baseUrl);
      if (previousApiKey) updated = updated.replaceAll(previousApiKey, includeApiKey ? API_KEY : '{{apiKey}}');
      return updated;
    }
    if (Array.isArray(value)) return value.map(replaceValues);
    if (value && typeof value === 'object') {
      Object.keys(value).forEach((key) => { value[key] = replaceValues(value[key]); });
    }
    return value;
  };

  replaceValues(collection);
  if (baseUrlVariable) baseUrlVariable.value = baseUrl;
  if (apiKeyVariable) apiKeyVariable.value = includeApiKey ? API_KEY : '{{apiKey}}';
  if (whatsappManager.loggedInNumber) {
    if (phoneVariable) phoneVariable.value = whatsappManager.loggedInNumber;
    if (chatIdVariable) chatIdVariable.value = whatsappManager.loggedInNumber;
  }
  const authValue = collection.auth?.apikey?.find((entry) => entry.key === 'value');
  if (authValue) authValue.value = includeApiKey ? API_KEY : '{{apiKey}}';
  return collection;
}

function updatePostmanCollection() {
  const collection = createPostmanCollection(`http://localhost:${PORT}`, false);
  fs.writeFileSync(postmanCollectionPath, `${JSON.stringify(collection, null, 2)}\n`);
}

whatsappManager.on('status_change', ({ status }) => {
  if (status === 'ready') {
    try {
      updatePostmanCollection();
    } catch (err) {
      console.error('[server] Failed to update Postman collection:', err.message);
    }
  }
});

function publishLog(level, args) {
  const entry = {
    level,
    message: util.format(...args),
    timestamp: new Date().toISOString(),
  };
  logHistory.push(entry);
  if (logHistory.length > 500) logHistory.shift();
  const data = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) client.write(data);
}

// Keep the terminal quiet while retaining all application output for the log viewer.
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => publishLog(level, args);
}

function hasApiKey(req) {
  const provided = req.get('x-api-key');
  return provided === API_KEY;
}

function requireApiKey(req, res, next) {
  if (!hasApiKey(req)) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized. Missing or invalid API key.',
      hint: 'Pass the key in the "x-api-key" header.',
    });
  }
  next();
}

function createLogSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  logSessions.set(token, Date.now() + 15 * 60 * 1000);
  res.setHeader('Set-Cookie', `wpcore_log_session=${token}; Max-Age=900; Path=/; HttpOnly; SameSite=Strict`);
}

function requireLogSession(req, res, next) {
  const cookie = req.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)wpcore_log_session=([^;]+)/);
  const expiresAt = match && logSessions.get(match[1]);
  if (!expiresAt || expiresAt < Date.now()) {
    if (match) logSessions.delete(match[1]);
    return res.status(401).json({ success: false, error: 'Log session expired. Authenticate again.' });
  }
  next();
}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// API KEY AUTH — every /api request must pass the key.
// Send it in the `x-api-key` header.
// ---------------------------------------------------------------------------
app.use('/api', (req, res, next) => {
  // QR PNG images must be viewable directly in a browser (<img src> / opening
  // the url) — browsers can't send x-api-key headers for plain image loads.
  // The unguessable random id in the path (e.g. /qr/1da38efa.png) acts as the
  // capability token, and the id rotates with every QR refresh.
  if (req.method === 'GET' && /^\/login\/qr\/[a-f0-9]+\.png$/.test(req.path)) {
    return next();
  }

  requireApiKey(req, res, next);
});

// Routes
app.use('/api', apiRoutes);

app.get('/postman/collection.json', requireApiKey, (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const collection = createPostmanCollection(baseUrl, true);
  res.set('Content-Disposition', 'attachment; filename="wpcore.postman_collection.json"');
  res.json(collection);
});

app.get('/logs/check', requireApiKey, (req, res) => {
  createLogSession(res);
  res.json({ success: true });
});

// Root endpoint: authenticated live server log viewer
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>wpcore / live logs</title>
<style>
:root{color-scheme:dark;--bg:#0b1115;--panel:#111a20;--panel2:#162229;--line:#263943;--text:#e6eef1;--muted:#8da1a9;--teal:#47d7b0;--amber:#f3bd69;--red:#ff7f73}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -20%,#173b3d 0,transparent 38%),var(--bg);color:var(--text);font:14px "Cascadia Code","Segoe UI",sans-serif;min-height:100vh}
.shell{width:min(1240px,calc(100% - 36px));margin:0 auto;padding:38px 0 54px}.eyebrow{color:var(--teal);font-size:11px;letter-spacing:2px;text-transform:uppercase}.dot{width:7px;height:7px;border-radius:50%;background:var(--teal);box-shadow:0 0 12px var(--teal)}
.login{max-width:500px;margin:12vh auto 0;padding:34px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(145deg,#14252b,#10181d);box-shadow:0 24px 80px #0008}.login h2{margin:0 0 8px;font:600 30px Georgia,serif}.login p{margin:0 0 28px;color:var(--muted);line-height:1.6}.field{display:flex;gap:10px}.field input{min-width:0;flex:1}.input,button,select{border:1px solid var(--line);border-radius:7px;background:var(--panel2);color:var(--text);font:inherit;padding:11px 13px}.input:focus,select:focus{outline:2px solid #47d7b055;border-color:var(--teal)}button{background:var(--teal);border-color:var(--teal);color:#09201b;font-weight:700;cursor:pointer}button:hover{filter:brightness(1.08)}
.modal{position:fixed;inset:0;display:grid;place-items:center;padding:20px;background:#05090ccc;z-index:2}.modal[hidden]{display:none}.modal-card{width:min(420px,100%);padding:28px;border:1px solid #633b3b;border-radius:12px;background:#1a1719;box-shadow:0 24px 80px #000b}.modal-card h2{margin:0 0 10px;color:var(--red);font:600 24px Georgia,serif}.modal-card p{margin:0 0 22px;color:var(--muted);line-height:1.5}.modal-card button{background:var(--red);border-color:var(--red);color:#260c0a}
.workspace{display:none}.summary{display:grid;grid-template-columns:1fr auto;align-items:end;gap:20px;margin-bottom:22px}.summary h2{margin:0;font:600 32px Georgia,serif}.summary p{margin:7px 0 0;color:var(--muted)}.status{display:flex;align-items:center;gap:9px;color:var(--teal);font-size:12px}.toolbar{display:flex;gap:9px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:#0e171c;margin-bottom:12px}.toolbar input{flex:1;min-width:100px}.toolbar select{width:130px}.toolbar button{padding:10px 13px;background:transparent;color:var(--muted);border-color:var(--line)}.toolbar button:hover{color:var(--text);background:var(--panel2)}
.logframe{border:1px solid var(--line);border-radius:10px;background:#0b1216;overflow:hidden}.loghead{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}.loghead strong{color:var(--text);font-weight:500}.logs{height:min(64vh,680px);overflow:auto;padding:8px 0}.entry{display:grid;grid-template-columns:170px 60px 1fr;gap:14px;padding:7px 16px;line-height:1.45;border-left:2px solid transparent}.entry:hover{background:#132027}.time{color:#71868e}.level{text-transform:uppercase;font-size:10px;letter-spacing:1px;color:var(--teal);padding-top:2px}.entry.warn{border-left-color:var(--amber)}.entry.warn .level{color:var(--amber)}.entry.error{border-left-color:var(--red)}.entry.error .level{color:var(--red)}.message{white-space:pre-wrap;overflow-wrap:anywhere}.empty{padding:50px 20px;text-align:center;color:var(--muted)}
@media(max-width:700px){.shell{width:min(100% - 22px,1240px);padding-top:22px}.summary{display:block}.summary h2{font-size:28px}.status{margin-top:15px}.toolbar{flex-wrap:wrap}.toolbar input{flex-basis:100%}.toolbar select{flex:1}.entry{grid-template-columns:1fr;gap:2px;padding:9px 12px}.level{order:2}.message{order:3}.time{font-size:11px}.login{margin-top:8vh;padding:26px 22px}}
</style></head>
<body><div class="shell"><section class="login" id="login"><h2>Connect to your logs</h2><p>Authenticate this browser session to watch server activity as it happens.</p><form id="form" class="field"><input class="input" id="key" type="password" placeholder="Enter API key" autocomplete="off" autofocus><button id="connect" type="submit">Connect</button></form></section><div class="modal" id="errorModal" hidden><div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="errorTitle"><h2 id="errorTitle">Connection failed</h2><p id="errorMessage">The API key is invalid.</p><button id="closeError" type="button">Try again</button></div></div>
<main class="workspace" id="workspace"><div class="summary"><div><div class="eyebrow">Runtime telemetry</div><h2>Server activity</h2><p>Events received from the wpcore process.</p></div><div class="status"><span class="dot"></span><span id="connection">Connecting</span></div></div><div class="toolbar"><input class="input" id="search" placeholder="Search messages..." autocomplete="off"><select id="level"><option value="all">All levels</option><option value="log">Log</option><option value="info">Info</option><option value="warn">Warnings</option><option value="error">Errors</option></select><button id="clear" type="button">Clear view</button><button id="download" type="button">Download Postman JSON</button></div><div class="logframe"><div class="loghead"><strong>Event stream</strong><span id="count">0 events</span></div><div class="logs" id="logs"><div class="empty">Waiting for server events...</div></div></div></main></div>
<script>const login=document.getElementById('login'),workspace=document.getElementById('workspace'),form=document.getElementById('form'),key=document.getElementById('key'),connect=document.getElementById('connect'),errorModal=document.getElementById('errorModal'),errorMessage=document.getElementById('errorMessage'),closeError=document.getElementById('closeError'),logs=document.getElementById('logs'),search=document.getElementById('search'),level=document.getElementById('level'),count=document.getElementById('count'),connection=document.getElementById('connection'),download=document.getElementById('download');let entries=[],source,sessionKey;
function render(){const query=search.value.toLowerCase(),filter=level.value;logs.innerHTML='';const visible=entries.filter(entry=>(filter==='all'||entry.level===filter)&&(!query||entry.message.toLowerCase().includes(query)));if(!visible.length){logs.innerHTML='<div class="empty">No matching events.</div>'}else{visible.reverse().forEach(entry=>{const line=document.createElement('div');line.className='entry '+entry.level;line.dataset.level=entry.level;line.innerHTML='<span class="time">'+new Date(entry.timestamp).toLocaleTimeString()+'</span><span class="level">'+entry.level+'</span><span class="message"></span>';line.querySelector('.message').textContent=entry.message;logs.appendChild(line)})}count.textContent=entries.length+' event'+(entries.length===1?'':'s')}
function add(entry){entries.push(entry);if(entries.length>500)entries.shift();render();logs.scrollTop=0}
function showError(message){errorMessage.textContent=message;errorModal.hidden=false;connect.disabled=false;key.focus()}
closeError.onclick=()=>{errorModal.hidden=true;key.focus()};
form.onsubmit=async event=>{event.preventDefault();const value=key.value.trim();if(!value)return;connect.disabled=true;try{const validation=await fetch('/logs/check',{headers:{'x-api-key':value}});if(validation.status===401){showError('The API key is incorrect. Please check it and try again.');return}if(!validation.ok){showError('The server could not validate this connection. Please try again.');return}sessionKey=value;login.style.display='none';workspace.style.display='block';source=new EventSource('/logs');source.onopen=()=>{connection.textContent='Live';connection.previousElementSibling.style.background='var(--teal)'};source.onmessage=event=>add(JSON.parse(event.data));source.onerror=()=>{source.close();workspace.style.display='none';login.style.display='block';showError('The log stream could not be opened. Please try again.')}}catch(error){showError('The server could not be reached. Please try again.')}};search.oninput=render;level.onchange=render;document.getElementById('clear').onclick=()=>{entries=[];render()};download.onclick=async()=>{const response=await fetch('/postman/collection.json',{headers:{'x-api-key':sessionKey}});if(!response.ok)return;const blob=await response.blob(),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='wpcore.postman_collection.json';link.click();URL.revokeObjectURL(link.href)};
</script></body></html>`);
});

app.get('/logs', requireLogSession, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const entry of logHistory) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  logClients.add(res);
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    logClients.delete(res);
  });
});

// 404 handler — explains what went wrong (unknown route vs wrong HTTP method)
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found!`,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  // A client closing the connection while multer is reading multipart data is
  // expected for aborted uploads and should not be reported as an app error.
  if (err.message === 'Request aborted' || err.code === 'ECONNABORTED') {
    if (!res.headersSent) res.status(499).end();
    return;
  }

  console.error('[server] Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

async function start() {
  try {
    updatePostmanCollection();
  } catch (err) {
    console.error('[server] Failed to update Postman collection:', err.message);
  }

  app.listen(PORT, () => {
    process.stdout.write(`Server is Live on http://localhost:${PORT}\n`);

    try {
      whatsappManager.initialize();
    } catch (err) {
      console.error('[server] Failed to start:', err);
    }
  });
}

start();
