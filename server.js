const express = require('express');
const path = require('path');
const bot = require('./bot');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
const logBuffer = [];
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
bot.on('log', entry => {
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  console.log(`[${entry.level}] ${entry.text}`);
  broadcast('log', entry);
});
bot.on('status', snap => broadcast('status', snap));
bot.on('inbox', data => broadcast('inbox', data));
bot.on('alert', data => broadcast('alert', data));

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: status\ndata: ${JSON.stringify(bot.snapshot())}\n\n`);
  res.write(`event: inbox\ndata: ${JSON.stringify(bot.inboxState)}\n\n`);
  for (const e of logBuffer) res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.get('/api/config', (req, res) => res.json(store.getConfig()));
app.post('/api/config', (req, res) => res.json(store.setConfig(req.body || {})));
app.post('/api/config/reset-message', (req, res) => res.json(store.resetMessage()));
app.get('/api/state', (req, res) => res.json(bot.snapshot()));

const wrap = fn => async (req, res) => {
  try { await fn(); res.json(bot.snapshot()); }
  catch (e) { bot.log('Error: ' + e.message, 'error'); res.status(500).json({ error: e.message }); }
};
app.post('/api/browser/open', wrap(() => bot.openBrowser()));
app.post('/api/start', wrap(() => bot.start()));
app.post('/api/stop', wrap(async () => bot.stop()));
app.get('/api/inbox', (req, res) => res.json(bot.inboxState));
app.post('/api/inbox/refresh', wrap(() => bot.refreshInbox()));
app.post('/api/inbox/reply', async (req, res) => {
  try {
    const { connectionId, to, body } = req.body || {};
    await bot.reply(connectionId, to, body);
    res.json(bot.inboxState);
  } catch (e) {
    bot.log('Reply failed: ' + e.message, 'error');
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`CFL Connector running → http://localhost:${PORT}`));
