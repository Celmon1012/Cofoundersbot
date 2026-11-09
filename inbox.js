const store = require('./store');

const idOf = v => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v._id || v.id || '';
};
function samePerson(author, theirId) {
  if (!author || !theirId) return false;
  if (idOf(author) === theirId) return true;
  if (author.founder && idOf(author.founder) === theirId) return true;
  if (author.user && idOf(author.user) === theirId) return true;
  return false;
}

function dig(obj, pred, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return null;
  seen.add(obj);
  if (pred(obj)) return obj;
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of values) {
    const found = dig(v, pred, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function threadList(json) {
  const arrays = [];
  const seen = new Set();
  (function walk(v, depth) {
    if (!v || typeof v !== 'object' || depth > 5 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      if (v.some(x => x && typeof x === 'object' && (x.latestMessage || x.receiver || x.authorProfile))) arrays.push(v);
      return;
    }
    for (const child of Object.values(v)) walk(child, depth + 1);
  })(json, 0);
  arrays.sort((a, b) => b.length - a.length);
  return arrays[0] || [];
}

function textOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.body || v.text || v.message || '';
}

function chatOf(json) {
  return dig(json, v => v && !Array.isArray(v) && Array.isArray(v.messages)) || null;
}

function personName(p) {
  if (!p) return '';
  return `${p.firstName || ''} ${p.lastName || ''}`.trim();
}

async function readToken(bot) {
  const pages = [bot.inboxPage, bot.page].filter(p => p && !p.isClosed());
  for (const page of pages) {
    try {
      const token = await page.evaluate(() => {
        const saved = localStorage.getItem('token');
        if (saved) return saved;
        const m = document.cookie.match(/(?:^|; )token=([^;]*)/);
        return m ? decodeURIComponent(m[1]) : '';
      });
      if (token) return token;
    } catch { /* this tab is navigating */ }
  }
  return '';
}

async function cfl(bot, path, fields, json) {
  if (!bot.token) bot.token = await readToken(bot);
  if (!bot.token) return { status: 401, data: { message: 'Not logged in' } };
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + bot.token };
  if (json) headers['Content-Type'] = 'application/json';
  const url = path.startsWith('http') ? path : 'https://cofounderslab.com/api/backend' + path;
  const res = await bot.context.request.fetch(url, {
    method: fields || json ? 'POST' : 'GET',
    headers,
    multipart: fields || undefined,
    data: json || undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 180) }; }
  if (res.status() === 401) bot.token = null;
  return { status: res.status(), data };
}

function guessMyId(threads) {
  const counts = new Map();
  for (const t of threads) {
    const id = idOf(t.authorProfile);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = '';
  let n = 0;
  for (const [id, c] of counts) if (c > n) { best = id; n = c; }
  return best;
}

function alreadyAnswered(item) {
  const saved = store.replyFor(item.connectionId);
  if (!saved) return false;
  const latest = item.messages[item.messages.length - 1];
  if (!latest) return true;
  if (saved.messageId && saved.messageId === latest.id) return true;
  if (Array.isArray(saved.covered) && saved.covered.length && item.messages.every(m => saved.covered.includes(m.id))) return true;
  if (saved.latestBody && saved.latestBody === latest.body && (!latest.at || !saved.at || new Date(latest.at).getTime() <= new Date(saved.at).getTime())) return true;
  if (saved.at && latest.at && new Date(latest.at).getTime() <= new Date(saved.at).getTime()) return true;
  return false;
}

function publish(bot, patch) {
  bot.inboxState = { ...bot.inboxState, ...patch, updatedAt: new Date().toISOString() };
  bot.emit('inbox', bot.inboxState);
}

async function refresh(bot) {
  if (bot.inboxBusy) { bot.inboxAgain = true; return bot.inboxState; }
  const page = bot.page;
  if (!page || page.isClosed()) {
    publish(bot, { items: [], error: 'Open the browser and log in to check replies.' });
    return bot.inboxState;
  }
  if (!page.url().includes('cofounderslab.com')) {
    publish(bot, { items: bot.inboxState.items || [], error: 'Log in in the browser window first.' });
    return bot.inboxState;
  }

  bot.inboxBusy = true;
  try {
    const deep = !bot.inboxDeepAt || Date.now() - bot.inboxDeepAt > 10 * 60 * 1000;
    const maxPages = deep ? 40 : 2;
    if (deep) bot.inboxDeepAt = Date.now();
    const threads = [];
    let listStatus = 0;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const listRes = await cfl(bot, `/connections?limit=20&page=${pageNo}`);
      listStatus = listRes.status;
      if (listRes.status === 401 || listRes.status === 403) break;
      if (listRes.status < 200 || listRes.status >= 300) break;
      const batch = threadList(listRes.data);
      if (!batch.length) break;
      threads.push(...batch);
    }
    const unreadRes = await cfl(bot, '/connections?limit=20&page=1&msgStatus=unread');
    const unread = unreadRes.status >= 200 && unreadRes.status < 300 ? threadList(unreadRes.data) : [];
    if (unread.length) threads.push(...unread);
    if (!bot.inboxUnreadLogged) {
      bot.inboxUnreadLogged = true;
      bot.log(`Unread list: HTTP ${unreadRes.status}, ${unread.length} conversations`, 'info');
    }
    if (listStatus === 401 || listStatus === 403) {
      publish(bot, { items: [], error: 'Not logged in. Log in in the browser window, then check again.' });
    } else if (!threads.length && (listStatus < 200 || listStatus >= 300)) {
      publish(bot, { items: bot.inboxState.items || [], error: 'Could not load messages (HTTP ' + listStatus + ').' });
    } else {
    if (!bot.myId) bot.myId = guessMyId(threads);

    const seenThreads = new Set();
    const incoming = [];
    for (const thread of threads) {
      if (!thread || !thread._id || seenThreads.has(thread._id)) continue;
      seenThreads.add(thread._id);
      const latestText = textOf(thread.latestMessage);
      const note = typeof thread.message === 'string' ? thread.message : textOf(thread.message);
      const latestFromMe = thread.latestMessage && samePerson(thread.latestMessage.authorProfile, bot.myId);
      const noteFromMe = samePerson(thread.authorProfile, bot.myId);
      if (latestText && !latestFromMe) incoming.push(thread);
      else if (!latestText && note && !noteFromMe) incoming.push(thread);
    }
    const summary = `${threads.length}/${incoming.length}`;
    if (bot.inboxSummary !== summary) {
      bot.inboxSummary = summary;
      bot.log(`Inbox: ${threads.length} conversations, ${incoming.length} with a message from someone else`, 'info');
    }

    const items = [];
    for (const thread of incoming.slice(0, 40)) {
      let chat = null;
      try {
        const detail = await cfl(bot, '/connections/' + encodeURIComponent(thread._id));
        if (detail.status >= 200 && detail.status < 300) chat = chatOf(detail.data);
      } catch { /* try again next poll */ }

      const profiles = ((chat && chat.profiles) || []).filter(p => p && p._id);
      if (!bot.myId && profiles.length === 2 && thread.authorProfile) {
        const mine = profiles.find(p => p._id === idOf(thread.authorProfile));
        if (mine) bot.myId = mine._id;
      }
      const other = profiles.find(p => p._id !== bot.myId)
        || (thread.receiver && idOf(thread.receiver) !== bot.myId ? thread.receiver : null);

      let theirs = ((chat && chat.messages) || [])
        .filter(m => textOf(m) && !samePerson(m.authorProfile, bot.myId))
        .map(m => ({
          id: String(m._id || m.id || m.createdAt || ''),
          body: textOf(m),
          at: m.createdAt || m.updatedAt || null,
        }))
        .filter(m => m.id);

      if (!theirs.length) {
        const body = textOf(thread.latestMessage) || (samePerson(thread.authorProfile, bot.myId) ? '' : (typeof thread.message === 'string' ? thread.message : textOf(thread.message)));
        const latest = thread.latestMessage;
        const id = String((latest && (latest._id || latest.id)) || ('note:' + thread._id));
        const at = (latest && (latest.createdAt || latest.updatedAt)) || thread.createdAt || null;
        if (body) theirs.push({ id, body, at });
      }
      if (!theirs.length) continue;
      theirs.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
      theirs = theirs.slice(-8);

      items.push({
        id: theirs[theirs.length - 1].id,
        connectionId: thread._id,
        to: (other && other._id) || idOf(thread.latestMessage && thread.latestMessage.authorProfile) || idOf(thread.receiver),
        name: personName(other) || personName(thread.receiver) || 'Someone',
        messages: theirs,
      });
    }
    if (!deep) {
      const byId = new Map((bot.inboxState.items || []).map(item => [item.connectionId, item]));
      for (const item of items) byId.set(item.connectionId, item);
      items.splice(0, items.length, ...byId.values());
    }

    const visible = items.filter(item => !alreadyAnswered(item));
    const known = store.notifiedIds();
    const fresh = visible.filter(item => item.messages.some(m => !known.has(m.id)));
    const recent = fresh.filter(item => {
      const last = item.messages[item.messages.length - 1];
      return last.at && Date.now() - new Date(last.at).getTime() < 12 * 60 * 60 * 1000;
    });
    if (recent.length) {
      const names = [...new Set(recent.map(i => i.name))];
      const shown = names.slice(0, 3).join(', ');
      const extra = names.length > 3 ? ` and ${names.length - 3} more` : '';
      bot.log(`New reply from ${shown}${extra}`, 'warn');
      const first = recent[0];
      const last = first.messages[first.messages.length - 1];
      bot.emit('alert', {
        title: `Reply from ${first.name}`,
        body: last.body.slice(0, 180),
        count: recent.length,
      });
    }
    const answeredIds = items.filter(alreadyAnswered).flatMap(i => i.messages.map(m => m.id));
    if (fresh.length || answeredIds.length) store.markNotified([...fresh.flatMap(i => i.messages.map(m => m.id)), ...answeredIds]);

    publish(bot, { items: visible, error: null });
    }
  } catch (e) {
    publish(bot, { items: bot.inboxState.items || [], error: 'Inbox check failed: ' + e.message });
  } finally {
    bot.inboxBusy = false;
  }
  if (bot.inboxAgain) {
    bot.inboxAgain = false;
    return refresh(bot);
  }
  return bot.inboxState;
}

async function reply(bot, connectionId, to, body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Write a reply first.');
  if (!connectionId || !to) throw new Error('That conversation is missing a recipient.');
  const page = bot.page;
  if (!page || page.isClosed() || !page.url().includes('cofounderslab.com')) {
    throw new Error('Open the browser and log in first.');
  }
  const res = await cfl(bot, '/connections/messages', { body: text, to, connectionId });
  if (res.status < 200 || res.status >= 300) {
    const msg = (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status);
    throw new Error(typeof msg === 'string' ? msg : 'Could not send the reply.');
  }
  const match = (bot.inboxState.items || []).find(i => i.connectionId === connectionId);
  const latest = match && match.messages && match.messages[match.messages.length - 1];
  store.rememberReply(connectionId, {
    body: text,
    at: new Date().toISOString(),
    messageId: (match && match.id) || (latest && latest.id) || '',
    latestBody: latest ? latest.body : '',
    covered: match ? match.messages.map(m => m.id) : [],
  });
  const items = (bot.inboxState.items || []).filter(item => item.connectionId !== connectionId);
  publish(bot, { items, error: null });
  bot.log(`Reply sent to ${match ? match.name : 'them'}`, 'success');
  await refresh(bot);
  return bot.inboxState;
}

module.exports = { refresh, reply, cfl };
