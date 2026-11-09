const path = require('path');
const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const store = require('./store');
const inbox = require('./inbox');

const PROFILE_DIR = path.join(__dirname, 'data', 'browser-profile');
const rand = (a, b) => a + Math.random() * (b - a);
const exactBtn = (page, label) =>
  page.locator('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });

function responseMessage(text) {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    if (typeof j === 'string') return j;
    if (typeof j.message === 'string') return j.message;
    if (typeof j.error === 'string') return j.error;
    if (j.data && typeof j.data.message === 'string') return j.data.message;
  } catch { /* body is not JSON */ }
  return String(text);
}
// A 400/409 here means this person was already contacted. Account-wide limits are separate.
function isAccountLimit(msg) {
  return /rate limit|too many requests|daily limit|maximum number|quota/i.test(msg);
}
function isAlreadySent(status, msg) {
  if (/already|exist|pending|duplicate/i.test(msg)) return true;
  return status === 400 || status === 409;
}
function isTimeout(status, msg) {
  if (!status) return true;
  return /timeout|timed out|net::ERR|aborted|detached/i.test(String(msg || ''));
}

class Bot extends EventEmitter {
  constructor() {
    super();
    this.context = null;
    this.page = null;
    this.running = false;
    this.status = 'idle';
    this.nextSendAt = null;
    this.inboxTimer = null;
    this.inboxBusy = false;
    this.myId = null;
    this.inboxState = { items: [], error: null, updatedAt: null };
    this.newQueue = [];
    this.pageQueue = [];
    this.newMemberAt = 0;
    this.wantRun = false;
  }

  log(text, level = 'info') {
    this.emit('log', { time: new Date().toISOString(), level, text });
  }
  setStatus(s) {
    this.status = s;
    this.emit('status', this.snapshot());
  }
  snapshot() {
    return {
      status: this.status,
      running: this.running,
      browserOpen: !!this.page && !this.page.isClosed(),
      nextSendAt: this.nextSendAt,
      startUrl: store.getConfig().startUrl,
      state: store.getState(),
    };
  }

  async currentSearchUrl() {
    const page = this.page;
    if (!page || page.isClosed()) return this.lastSearchUrl || '';
    try {
      return await page.evaluate(() => {
        if (!location.href.includes('/search')) return '';
        const url = new URL(location.href);
        if (!url.searchParams.get('page')) {
          const active = [...document.querySelectorAll('button')].find(b =>
            /\bbg-primary-v2\b/.test(b.className) && /^\d+$/.test((b.textContent || '').trim())
          );
          if (active) url.searchParams.set('page', active.textContent.trim());
        }
        return url.searchParams.get('page') ? url.toString() : '';
      });
    } catch {
      return this.lastSearchUrl || '';
    }
  }

  async rememberPage() {
    const href = await this.currentSearchUrl();
    if (!href) return;
    this.lastSearchUrl = href;
    if (href === store.getConfig().startUrl) return;
    store.setConfig({ startUrl: href });
    const pageNo = new URL(href).searchParams.get('page');
    this.log(`Saved last page → page ${pageNo}`, 'info');
    this.emit('status', this.snapshot());
  }

  startInbox() {
    if (this.inboxTimer) return;
    this.inboxTimer = setInterval(() => { this.refreshInbox(); }, 25000);
    this.refreshInbox();
  }
  stopInbox() {
    if (this.inboxTimer) clearInterval(this.inboxTimer);
    this.inboxTimer = null;
  }
  refreshInbox() { return inbox.refresh(this); }
  reply(connectionId, to, body) { return inbox.reply(this, connectionId, to, body); }

  async openBrowser() {
    if (this.page && !this.page.isClosed()) {
      await this.page.bringToFront();
      this.startInbox();
      return;
    }
    this.log('Opening browser…');
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--start-maximized'],
    });
    this.context.on('close', () => {
      if (this.lastSearchUrl && this.lastSearchUrl !== store.getConfig().startUrl) {
        store.setConfig({ startUrl: this.lastSearchUrl });
      }
      this.stopInbox();
      this.page = null; this.context = null;
      if (this.running) { this.running = false; this.log('Browser was closed — stopped.', 'warn'); }
      this.inboxState = { ...this.inboxState, error: 'Browser closed. Open it again to check replies.', updatedAt: new Date().toISOString() };
      this.emit('inbox', this.inboxState);
      this.setStatus('browser closed');
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.goToSearch(store.getConfig().startUrl);
    this.log('Browser open. If you see a login page, log in there once — the session is remembered.');
    this.setStatus('browser ready');
    this.startInbox();
  }

  async goToSearch(url) {
    const target = url || store.getConfig().startUrl;
    const page = this.page;
    if (!page || page.isClosed()) throw new Error('Browser is closed.');
    const here = page.url();
    if (here.includes('cofounderslab.com/search')) return;
    let lastErr = null;
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      if (page.isClosed()) throw lastErr || new Error('Browser is closed.');
      try {
        await page.goto(target, { waitUntil: 'commit', timeout: 90000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
        return;
      } catch (e) {
        lastErr = e;
        if (/closed|Target page|context or browser has been closed/i.test(e.message)) throw e;
        this.log(`Search page was slow (try ${tryNo}/3). Waiting, then trying again…`, 'warn');
        await new Promise(r => setTimeout(r, 2500));
        if (page.url().includes('cofounderslab.com/search')) return;
      }
    }
    if (page.url().includes('cofounderslab.com')) {
      this.log('Search page is still loading. Continuing from here.', 'warn');
      return;
    }
    throw lastErr;
  }

  // Sleep in small slices so Stop takes effect quickly.
  async wait(ms) {
    const end = Date.now() + ms;
    while (this.running && Date.now() < end) await new Promise(r => setTimeout(r, 500));
  }

  async start() {
    if (this.running) return;
    this.wantRun = true;
    await this.openBrowser();
    this.running = true;
    this.setStatus('running');
    this.log('Started.');
    this.loop()
      .catch(err => this.log('Error: ' + err.message, 'error'))
      .finally(async () => {
        await this.rememberPage();
        this.running = false;
        this.nextSendAt = null;
        const hardStop = /daily limit|needs login|browser closed/.test(this.status);
        if (this.wantRun && !hardStop && this.page && !this.page.isClosed()) {
          this.log('A send stalled. Waiting 20 seconds, then continuing…', 'warn');
          this.setStatus('retrying');
          setTimeout(() => {
            if (this.wantRun && !this.running) this.start().catch(err => this.log('Error: ' + err.message, 'error'));
          }, 20000);
          return;
        }
        if (this.status === 'running' || this.status === 'retrying') this.setStatus('stopped');
      });
  }

  async stop() {
    this.wantRun = false;
    if (!this.running) { await this.rememberPage(); return; }
    this.running = false;
    this.nextSendAt = null;
    await this.rememberPage();
    this.log('Stopping…');
    this.setStatus('stopped');
  }

  async profileFromButton(btn) {
    return btn.evaluate(b => {
      let c = b;
      for (let i = 0; i < 10 && c; i++) {
        const link = c.querySelector && c.querySelector('a[href^="/profile/"]');
        if (link) {
          const name = (link.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || 'Unknown';
          return { key: link.getAttribute('href'), name, cardText: (c.innerText || '').slice(0, 600) };
        }
        c = c.parentElement;
      }
      return { key: null, name: 'Unknown', cardText: '' };
    }).catch(() => ({ key: null, name: 'Unknown', cardText: '' }));
  }

  terms(value, fallback) {
    const raw = value == null ? fallback : value;
    return String(raw || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
  }

  phraseHit(text, list) {
    const lower = String(text || '').toLowerCase();
    for (const term of list) {
      const t = term.toLowerCase().trim();
      if (t.length < 2) continue;
      const body = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]*');
      if (new RegExp('(^|[^a-z0-9])' + body + 's?([^a-z0-9]|$)', 'i').test(lower)) return term;
    }
    return '';
  }

  profileText(data) {
    const bits = [];
    const skipKey = /token|email|phone|password|url|picture|image|avatar|message|note|_id|id$/i;
    (function walk(v, key, depth) {
      if (v == null || depth > 5 || bits.join(' ').length > 5000) return;
      if (typeof v === 'string') {
        if (!skipKey.test(key || '') && v.length < 400) bits.push(v);
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { v.forEach(item => walk(item, key, depth + 1)); return; }
      for (const [k, val] of Object.entries(v)) {
        if (skipKey.test(k)) continue;
        walk(val, k, depth + 1);
      }
    })(data, '', 0);
    return bits.join('\n');
  }

  async profileDetail(slug) {
    if (!slug) return null;
    if (!this.profileCache) this.profileCache = new Map();
    if (this.profileCache.has(slug)) return this.profileCache.get(slug);
    const res = await inbox.cfl(this, '/founder/profile?slug=' + encodeURIComponent(slug));
    const data = res.status >= 200 && res.status < 300 ? res.data : null;
    this.profileCache.set(slug, data);
    if (!this.detailLogged && data) {
      this.detailLogged = true;
      const root = data.profile || data.founder || data.data || data;
      const keys = root && typeof root === 'object' ? Object.keys(root).slice(0, 24).join(', ') : 'none';
      this.log('Profile fields: ' + keys, 'info');
    }
    if (this.profileCache.size > 400) this.profileCache.delete(this.profileCache.keys().next().value);
    return data;
  }

  profileId(data) {
    if (!data) return '';
    const root = data.profile || data.founder || data.data || data;
    return (root && (root._id || root.id)) || data._id || '';
  }

  async excludeReason(info) {
    const cfg = store.getConfig();
    const countries = this.terms(cfg.skipCountries, '');
    const roles = this.terms(cfg.skipRoles, 'co-founder, developer');
    if (!countries.length && !roles.length) return '';
    const slug = String(info.key || info.slug || '').replace(/^\/profile\//, '');
    let detail = null;
    try { detail = await this.profileDetail(slug); }
    catch { detail = null; }
    const text = [info.cardText, info.tagline, this.profileText(info), this.profileText(detail)].filter(Boolean).join('\n');
    const country = this.phraseHit(text, countries);
    if (country) return `country ${country}`;
    const role = this.phraseHit(text, roles);
    if (role) return `role ${role}`;
    return '';
  }

  async mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length && this.running) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) || 0 }, worker));
    return out;
  }

  async collectPagePeople(skip) {
    const people = await this.page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const btn of document.querySelectorAll('button')) {
        if (!/^\s*Connect\s*$/.test(btn.textContent || '')) continue;
        if (btn.disabled) continue;
        let c = btn;
        for (let i = 0; i < 10 && c; i++) {
          const link = c.querySelector && c.querySelector('a[href^="/profile/"]');
          if (link) {
            const href = link.getAttribute('href');
            if (href && !seen.has(href)) {
              seen.add(href);
              const name = (link.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || 'Unknown';
              out.push({ key: href, name, cardText: (c.innerText || '').slice(0, 600) });
            }
            break;
          }
          c = c.parentElement;
        }
      }
      return out;
    }).catch(() => []);

    const unseen = people.filter(p => p.key && !this.seen(skip, p));
    if (!unseen.length) return [];
    this.log(`Checking ${unseen.length} people on this page before sending…`, 'info');
    const rows = await this.mapLimit(unseen, 5, async (p) => {
      const reason = await this.excludeReason(p);
      const slug = String(p.key || '').replace(/^\/profile\//, '');
      const detail = this.profileCache && this.profileCache.get(slug);
      return { p, reason, id: this.profileId(detail) || this.profileId(p) };
    });
    const keep = [];
    let skipped = 0;
    for (const row of rows) {
      if (!row) continue;
      const { p, reason, id } = row;
      if (reason) {
        this.remember(skip, p);
        store.record({ name: p.name, key: p.key, ok: false, status: 'skipped' });
        this.log(`Skipped ${p.name} — ${reason}`, 'warn');
        skipped++;
        continue;
      }
      keep.push({ id, key: p.key, name: p.name });
    }
    this.log(`${keep.length} to connect, ${skipped} skipped on this page`, 'info');
    return keep;
  }

  async sendNote(person) {
    const cfg = store.getConfig();
    const res = await inbox.cfl(this, 'https://apiv2.cofounderslab.com/api/v1/connection/connect', null, {
      message: cfg.message,
      profile: person.id,
    });
    return {
      status: res.status,
      detail: responseMessage(typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '')),
    };
  }

  async findConnectButton(key) {
    const buttons = exactBtn(this.page, 'Connect');
    const total = await buttons.count();
    for (let i = 0; i < total; i++) {
      const candidate = buttons.nth(i);
      if (await candidate.isDisabled().catch(() => true)) continue;
      const info = await this.profileFromButton(candidate);
      if (info.key === key) return candidate;
    }
    return null;
  }

  async noteText(box) {
    let text = String(store.getConfig().message || '').trim();
    const max = Number(await box.getAttribute('maxlength').catch(() => '') || 0);
    if (max > 0 && text.length > max) {
      text = text.slice(0, max);
      if (!this.noteTrimLogged) {
        this.noteTrimLogged = true;
        this.log(`Note was shortened to ${max} characters so the site will accept it.`, 'warn');
      }
    }
    return text;
  }

  async writeNote(box, text) {
    await box.click({ timeout: 3000 }).catch(() => {});
    await box.fill(text).catch(() => {});
    if ((await box.inputValue().catch(() => '')).trim()) return;
    // The dialog sometimes redraws and drops the note. Type it as a real paste so the page keeps it.
    await box.evaluate((el, value) => {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const tracker = el._valueTracker;
      if (tracker) tracker.setValue('\u0000');
      set.call(el, value);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, text).catch(() => {});
    if ((await box.inputValue().catch(() => '')).trim()) return;
    await this.page.keyboard.insertText(text);
  }

  async ensureNote(box, text) {
    for (let i = 0; i < 4 && this.running; i++) {
      await this.writeNote(box, text);
      await new Promise(r => setTimeout(r, 350));
      if (!(await box.inputValue().catch(() => '')).trim()) continue;
      await new Promise(r => setTimeout(r, 450));
      if ((await box.inputValue().catch(() => '')).trim()) return true;
    }
    return false;
  }

  async closeInvite(root) {
    const scope = root || this.page;
    const cancel = scope.locator('button').filter({ hasText: /^\s*Cancel\s*$/ }).last();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click({ timeout: 2000 }).catch(() => {});
      return;
    }
    await exactBtn(this.page, 'Cancel').last().click({ timeout: 2000 }).catch(() => {});
  }

  async sendVisible(person) {
    const page = this.page;
    const btn = await this.findConnectButton(person.key);
    if (!btn) return { status: 0, detail: 'no-button' };
    await btn.scrollIntoViewIfNeeded();
    await this.wait(rand(500, 900));
    if (!this.running) return { status: 0, detail: 'stopped' };
    await btn.click();

    const box = page.locator('textarea[name="message"]').filter({ visible: true }).last();
    try {
      await box.waitFor({ state: 'visible', timeout: 12000 });
    } catch {
      return { status: 0, detail: 'no-dialog' };
    }
    await new Promise(r => setTimeout(r, 500));
    const text = await this.noteText(box);
    if (!text) return { status: 0, detail: 'empty-note' };
    const send = exactBtn(page, 'Send').filter({ visible: true }).last();

    for (let attempt = 1; attempt <= 2 && this.running; attempt++) {
      const ready = await this.ensureNote(box, text);
      if (!this.running) {
        await this.closeInvite();
        return { status: 0, detail: 'stopped' };
      }
      if (!ready) {
        if (attempt === 1) {
          this.log('Note box was blank — typing the note again.', 'warn');
          continue;
        }
        await this.closeInvite();
        return { status: 0, detail: 'empty-note' };
      }
      const pending = page.waitForResponse(
        r => r.url().includes('/connection/connect') && r.request().method() === 'POST',
        { timeout: 20000 }
      );
      pending.catch(() => {});
      try {
        await send.click({ timeout: 8000 });
      } catch (e) {
        if (attempt === 1) {
          this.log('Send button was not clickable — trying again.', 'warn');
          continue;
        }
        await this.closeInvite();
        return { status: 0, detail: e.message };
      }
      const early = await Promise.race([
        pending.then(resp => ({ resp })).catch(error => ({ error })),
        new Promise(r => setTimeout(r, 1500)).then(async () => {
          const open = await box.isVisible().catch(() => false);
          const value = await box.inputValue().catch(() => '');
          if (open && !value.trim()) return { refill: true };
          return { wait: true };
        }),
      ]);
      if (early.resp) {
        return {
          status: early.resp.status(),
          detail: responseMessage(await early.resp.text().catch(() => '')),
        };
      }
      if (early.refill && attempt === 1) {
        this.log('Note was cleared — typing it again.', 'warn');
        continue;
      }
      try {
        const resp = early.error ? null : await pending;
        if (!resp) throw early.error || new Error('send timed out');
        return {
          status: resp.status(),
          detail: responseMessage(await resp.text().catch(() => '')),
        };
      } catch (e) {
        if (attempt === 1 && await box.isVisible().catch(() => false)) {
          this.log('Send did not go through — trying again.', 'warn');
          continue;
        }
        await this.closeInvite();
        return { status: 0, detail: e.message };
      }
    }
    await this.closeInvite();
    return { status: 0, detail: this.running ? 'empty-note' : 'stopped' };
  }

  // People we already tried, including earlier runs, so a failed or sent card is not clicked again.
  loadSkipped() {
    const keys = new Set();
    const names = new Set();
    for (const h of store.getState().history) {
      if (h.key) keys.add(h.key);
      const n = (h.name || '').trim().toLowerCase();
      if (n && n !== 'unknown') names.add(n);
    }
    return { keys, names };
  }
  seen(skip, info) {
    if (info.key && skip.keys.has(info.key)) return true;
    const n = (info.name || '').trim().toLowerCase();
    return !!(n && n !== 'unknown' && skip.names.has(n));
  }
  remember(skip, info) {
    if (info.key) skip.keys.add(info.key);
    const n = (info.name || '').trim().toLowerCase();
    if (n && n !== 'unknown') skip.names.add(n);
  }

  joinedAt(profile) {
    return profile.createdAt || profile.created_at || (profile.user && profile.user.createdAt) || '';
  }

  profilesFrom(data) {
    if (!data) return [];
    if (Array.isArray(data.profiles)) return data.profiles;
    if (data.data && Array.isArray(data.data.profiles)) return data.data.profiles;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.data)) return data.data;
    return [];
  }

  // People who created an account in the last 30 minutes.
  async pullNewMembers() {
    if (store.getConfig().watchNewMembers === false || this.newMemberHold) return;
    if (this.newMemberBusy || Date.now() - this.newMemberAt < 2 * 60 * 1000) return;
    this.newMemberBusy = true;
    try {
      const list = [];
      for (let pageNo = 1; pageNo <= 3; pageNo++) {
        const res = await inbox.cfl(this, '/founder/search?limit=20&page=' + pageNo);
        if (pageNo === 1) this.newMemberAt = Date.now();
        if (res.status < 200 || res.status >= 300) {
          let why = '';
          try { why = ' ' + JSON.stringify(res.data).slice(0, 180); } catch { /* ignore */ }
          if (!this.newMemberErr) this.log('Could not check for new members (HTTP ' + res.status + why + ')', 'warn');
          this.newMemberErr = true;
          if (!list.length) return;
          break;
        }
        this.newMemberErr = false;
        const batch = this.profilesFrom(res.data);
        if (!batch.length) break;
        list.push(...batch);
      }
      const sample = list[0];
      if (sample && !this.newMemberLogged) {
        this.newMemberLogged = true;
        const when = this.joinedAt(sample) || 'no join date';
        this.log(`Newest member on the site: ${(sample.firstName || '')} ${(sample.lastName || '')} (${when})`.replace(/\s+/g, ' ').trim(), 'info');
        if (!this.joinedAt(sample)) this.log('Join date was missing, so new registrations cannot be picked out yet. Fields: ' + Object.keys(sample).slice(0, 18).join(', '), 'warn');
      }
      const since = Date.now() - 30 * 60 * 1000;
      const skip = this.loadSkipped();
      const queued = new Set(this.newQueue.map(p => p.key));
      for (const profile of list) {
        const created = Date.parse(this.joinedAt(profile));
        if (!created || created < since) continue;
        const status = profile.connection && profile.connection.status;
        if (status && status !== 'none') continue;
        const key = '/profile/' + (profile.slug || profile._id);
        const name = `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || 'New member';
        if (!profile._id || queued.has(key) || this.seen(skip, { key, name })) continue;
        const reason = await this.excludeReason({ ...profile, key, name });
        if (reason) {
          this.remember(skip, { key, name });
          store.record({ name, key, ok: false, status: 'skipped' });
          this.log(`Skipped new member ${name} — ${reason}`, 'warn');
          continue;
        }
        this.newQueue.push({ id: profile._id, key, name });
        queued.add(key);
      }
      if (this.newQueue.length && this.newQueue.length !== this.newQueueNoted) {
        this.newQueueNoted = this.newQueue.length;
        this.log(`${this.newQueue.length} new registration${this.newQueue.length === 1 ? '' : 's'} in the last 30 minutes`, 'info');
      }
    } catch (e) {
      this.log('New-member check failed: ' + e.message, 'warn');
    } finally {
      this.newMemberBusy = false;
    }
  }

  async loop() {
    const page = this.page;
    let failures = 0;
    const skip = this.loadSkipped();

    if (!page.url().includes('cofounderslab.com/search')) {
      await this.goToSearch(store.getConfig().startUrl);
    }
    await this.wait(3000);
    await this.rememberPage();

    while (this.running) {
      await this.rememberPage();
      const cfg = store.getConfig();
      const st = store.getState();

      if (st.sentToday >= cfg.dailyLimit) {
        this.log(`Daily limit of ${cfg.dailyLimit} reached. Run again tomorrow.`, 'warn');
        this.setStatus('daily limit reached');
        break;
      }

      if (/\/login|\/signin/i.test(page.url())) {
        this.log('Not logged in — log in in the browser window, then press Start again.', 'warn');
        this.setStatus('needs login');
        break;
      }

      await this.pullNewMembers();
      if (this.newQueue.length) this.pageQueue.unshift(...this.newQueue.splice(0));
      if (!this.pageQueue.length) {
        this.pageQueue = await this.collectPagePeople(skip);
      }
      let person = this.pageQueue.shift();
      if (person) this.remember(skip, person);

      if (!person) {
        const next = exactBtn(page, 'Next').first();
        if (!(await next.count()) || (await next.isDisabled())) {
          if (store.getConfig().watchNewMembers !== false) {
            this.setStatus('watching new members');
            if (!this.watchingNoted) {
              this.watchingNoted = true;
              this.log('Search pages are finished. Still watching for people who register.', 'info');
            }
            await this.wait(60000);
            continue;
          }
          this.log('No more profiles to connect with.', 'warn');
          this.setStatus('finished');
          break;
        }
        this.log('Page done → next page');
        await this.rememberPage();
        await next.click();
        await this.wait(rand(4000, 7000));
        await this.rememberPage();
        continue;
      }

      let status = 0;
      let detail = '';
      try {
        const sent = await this.sendVisible(person);
        if (sent.detail === 'no-button' && person.id) {
          this.log(`${person.name} is not on this page — sending without the Connect box`, 'warn');
          const fallback = await this.sendNote(person);
          status = fallback.status;
          detail = fallback.detail;
        } else {
          status = sent.status;
          detail = sent.detail;
        }
      } catch (e) {
        detail = e.message;
      }

      if (detail === 'stopped') break;
      if (detail === 'no-dialog' || detail === 'empty-note' || isTimeout(status, detail)) {
        store.record({ name: person.name, key: person.key, ok: false, status: 'skipped' });
        const why = detail === 'empty-note' ? 'the note box stayed blank' : detail === 'no-dialog' ? 'the invite box did not open' : 'send timed out';
        this.log(`Skipped ${person.name} — ${why}. Moving to the next person.`, 'warn');
        await exactBtn(page, 'Cancel').first().click({ timeout: 2000 }).catch(() => {});
        await this.wait(rand(4000, 8000));
        continue;
      }

      if (status >= 200 && status < 300) {
        failures = 0;
        store.record({ name: person.name, key: person.key, ok: true, status });
        const s = store.getState();
        this.log(`✓ Sent to ${person.name}  (${s.sentToday}/${cfg.dailyLimit} today)`, 'success');
      } else if (isAccountLimit(detail)) {
        this.log(`Account limit from the site. Waiting 10 minutes, then continuing…`, 'error');
        store.record({ name: person.name, key: person.key, ok: false, status });
        await exactBtn(page, 'Cancel').first().click({ timeout: 2000 }).catch(() => {});
        await this.wait(10 * 60 * 1000);
        continue;
      } else if (isAlreadySent(status, detail) || /already|exist|pending|duplicate/i.test(detail) || status === 409) {
        store.record({ name: person.name, key: person.key, ok: false, status: 'skipped' });
        this.log(`Skipped ${person.name} — connection was already sent`, 'warn');
        await exactBtn(page, 'Cancel').first().click({ timeout: 2000 }).catch(() => {});
        await this.wait(rand(800, 1500));
        continue;
      } else {
        store.record({ name: person.name, key: person.key, ok: false, status: 'skipped' });
        this.log(`Skipped ${person.name} (HTTP ${status || 'error'}) — moving on`, 'warn');
        await exactBtn(page, 'Cancel').first().click({ timeout: 2000 }).catch(() => {});
        await this.wait(rand(3000, 6000));
        continue;
      }
      this.emit('status', this.snapshot());

      const delay = rand(cfg.minDelaySec, cfg.maxDelaySec) * 1000;
      this.nextSendAt = new Date(Date.now() + delay).toISOString();
      this.emit('status', this.snapshot());
      await this.wait(delay);
      this.nextSendAt = null;
    }
  }
}

module.exports = new Bot();
