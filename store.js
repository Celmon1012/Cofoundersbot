const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const INBOX_FILE = path.join(DATA_DIR, 'inbox.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_MESSAGE = `Hello friend, hope you're doing well!
I'm a Senior Full-Stack, AI & Software Engineer with 8+ years of experience, passionate about helping startups turn ideas into real, scalable products.
I'm also involved with Finazza.app, a startup project, where I gain hands-on experience with the technical challenges of building and growing a startup, from product development and architecture to automation and AI integration.
[Core Stack]
Python, JavaScript, TypeScript, Go, Node.js, React, Next.js, Playwright, Selenium, Puppeteer, CDP, REST APIs, WebSockets, PostgreSQL, Redis, Docker, OpenAI, Android, ADB
[What I Can Bring to Your Startup]

* MVP Development: Turn early-stage ideas into functional products quickly.
* Full-Stack Engineering: Build scalable SaaS platforms, dashboards, APIs, and web applications.
* AI & Automation: Develop AI agents, LLM integrations, intelligent workflows, and automation systems.
* Reverse Engineering: Analyze APIs, applications, and protocols to solve complex technical challenges.
* Startup Engineering: Help founders make practical technical decisions, reduce development costs, and launch faster.
* Long-Term Development: Improve existing products, optimize performance, and support growth.

[My Approach]
I don't just write code. I enjoy understanding the business behind a product, identifying technical challenges, and building solutions that create real value.
Having experience with Finazza.app has also helped me better understand the startup mindset, where speed, flexibility, ownership, and execution matter.
I'm always interested in connecting with founders, co-founders, and startup teams who need a reliable technical partner.
Whether you're building an MVP, adding AI features, improving an existing platform, or looking for someone to take ownership of development, I'd be happy to help.
If you're working on a startup, I'd love to hear what you're building and explore how I can contribute.
Thanks, and looking forward to connecting!
Whatsapp: +1 (920) 376-6079`;

const DEFAULT_CONFIG = {
  message: DEFAULT_MESSAGE,
  dailyLimit: 500,
  minDelaySec: 40,
  maxDelaySec: 100,
  startUrl: 'https://cofounderslab.com/search',
  maxConsecutiveFailures: 3,
};

function readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { ...fallback }; }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const today = () => new Date().toISOString().slice(0, 10);

let config = readJson(CONFIG_FILE, DEFAULT_CONFIG);
let state = readJson(STATE_FILE, { date: today(), sentToday: 0, totalSent: 0, history: [] });
let inbox = readJson(INBOX_FILE, { notified: [] });

module.exports = {
  getConfig: () => config,
  setConfig(patch) {
    const c = { ...config, ...patch };
    c.dailyLimit = Math.max(1, parseInt(c.dailyLimit, 10) || DEFAULT_CONFIG.dailyLimit);
    c.minDelaySec = Math.max(5, parseInt(c.minDelaySec, 10) || DEFAULT_CONFIG.minDelaySec);
    c.maxDelaySec = Math.max(c.minDelaySec, parseInt(c.maxDelaySec, 10) || DEFAULT_CONFIG.maxDelaySec);
    c.maxConsecutiveFailures = Math.max(1, parseInt(c.maxConsecutiveFailures, 10) || 3);
    config = c;
    writeJson(CONFIG_FILE, config);
    return config;
  },
  resetMessage() { return module.exports.setConfig({ message: DEFAULT_MESSAGE }); },
  getState() {
    if (state.date !== today()) { state.date = today(); state.sentToday = 0; writeJson(STATE_FILE, state); }
    return state;
  },
  record(entry) {
    const s = module.exports.getState();
    if (entry.ok) { s.sentToday += 1; s.totalSent += 1; }
    s.history.unshift({ ...entry, time: new Date().toISOString() });
    s.history = s.history.slice(0, 2000);
    writeJson(STATE_FILE, s);
  },
  notifiedIds() {
    return new Set(inbox.notified || []);
  },
  markNotified(ids) {
    const set = new Set([...(inbox.notified || []), ...ids]);
    inbox.notified = [...set].slice(-800);
    writeJson(INBOX_FILE, inbox);
  },
  rememberReply(connectionId, reply) {
    inbox.replies = inbox.replies || {};
    inbox.replies[connectionId] = reply;
    const keys = Object.keys(inbox.replies);
    if (keys.length > 200) delete inbox.replies[keys[0]];
    writeJson(INBOX_FILE, inbox);
  },
  replyFor(connectionId) {
    return (inbox.replies && inbox.replies[connectionId]) || null;
  },
};
