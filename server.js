const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SIGNIN_FILE = path.join(__dirname, 'data.json');
const PEOPLE_FILE = path.join(__dirname, 'people.json');

function loadSigninData() {
  try { if (fs.existsSync(SIGNIN_FILE)) return JSON.parse(fs.readFileSync(SIGNIN_FILE, 'utf8')); } catch (e) {}
  return { currentVisitors: [], history: [] };
}
function saveSigninData(d) { fs.writeFileSync(SIGNIN_FILE, JSON.stringify(d, null, 2)); }

function loadPeople() {
  try { if (fs.existsSync(PEOPLE_FILE)) return JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')); } catch (e) {}
  return getDefaultPeople();
}
function savePeople(d) { fs.writeFileSync(PEOPLE_FILE, JSON.stringify(d, null, 2)); }

function getDefaultPeople() {
  return {
    projects: [
      {
        id: 'versa-staff', name: 'Versa Staff', visitorProject: false,
        people: [
          { id: 'p1',  name: 'Andrew Rowell',  jobTitle: 'Technical Manager',    nfcId: null },
          { id: 'p2',  name: 'Lily Britten',   jobTitle: 'Assistant Studio Manager', nfcId: null },
          { id: 'p3',  name: 'Chris Warden',   jobTitle: 'Group Head of Operations and Technology', nfcId: null },
          { id: 'p4',  name: 'Esther Brazil',  jobTitle: 'Assistant Operations Manager', nfcId: null },
          { id: 'p5',  name: 'Ian Curry',      jobTitle: 'Broadcast Engineer',   nfcId: null },
          { id: 'p6',  name: 'Ed Harvey',      jobTitle: 'Head of Studio',       nfcId: null },
          { id: 'p7',  name: 'Ben Riding',     jobTitle: 'Finance Manager',      nfcId: null }
        ]
      },
      {
        id: 'versa-freelance', name: 'Versa Freelance Crew', visitorProject: false,
        people: [
          { id: 'p8',  name: 'Howard Knock',    jobTitle: 'Sound Guarantee',    nfcId: null },
          { id: 'p9',  name: 'Andy McLannahan', jobTitle: 'Studio Engineer',    nfcId: null },
          { id: 'p10', name: 'Mark Openshaw',   jobTitle: 'Ingest',             nfcId: null },
          { id: 'p11', name: 'Simon Blunt',     jobTitle: 'Technical Manager',  nfcId: null },
          { id: 'p12', name: 'Oliver Riches',   jobTitle: 'Technical Manager',  nfcId: null }
        ]
      },
      { id: 'shopon-tv',   name: 'ShopOn TV',   visitorProject: false, people: [{ id: 'p13', name: 'Rob Locke', jobTitle: 'Head of Television / Presenter', nfcId: null }] },
      { id: 'dragons-den', name: 'Dragons Den', visitorProject: false, people: [] },
      { id: 'silverscape', name: 'Silverscape', visitorProject: false, people: [] },
      { id: 'visitor',     name: 'Visitor',     visitorProject: true,  people: [] }
    ]
  };
}

let signinData = loadSigninData();
let peopleData = loadPeople();

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Auto-delete visitors older than 7 days ───────────────────
function purgeOldVisitors() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const visitorProject = peopleData.projects.find(p => p.visitorProject);
  if (!visitorProject) return;
  const before = visitorProject.people.length;
  visitorProject.people = visitorProject.people.filter(p => {
    const added = p.addedAt ? new Date(p.addedAt).getTime() : 0;
    return added > cutoff;
  });
  if (visitorProject.people.length !== before) savePeople(peopleData);
  const histBefore = signinData.history.length;
  signinData.history = signinData.history.filter(v => {
    if (v.project !== 'Visitor') return true;
    const t = v.timeIn ? new Date(v.timeIn).getTime() : 0;
    return t > cutoff;
  });
  if (signinData.history.length !== histBefore) saveSigninData(signinData);
}
purgeOldVisitors();
setInterval(purgeOldVisitors, 60 * 60 * 1000);

// ── Helper: find person by NFC ID ────────────────────────────
function findPersonByNfc(nfcId) {
  for (const proj of peopleData.projects) {
    const person = proj.people.find(p => p.nfcId && p.nfcId === nfcId);
    if (person) return { person, project: proj };
  }
  return null;
}

// ── People API ───────────────────────────────────────────────
app.get('/api/people', (req, res) => res.json(peopleData));

app.post('/api/people', (req, res) => {
  const { name, jobTitle, projectId } = req.body;
  if (!name || !projectId) return res.status(400).json({ error: 'Name and projectId required' });
  const project = peopleData.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.visitorProject) {
    const dup = peopleData.projects.some(proj => proj.people.some(p => p.name.toLowerCase() === name.toLowerCase()));
    if (dup) return res.status(409).json({ error: 'Name already exists' });
  }
  const { company } = req.body;
  const person = { id: uid(), name, jobTitle: project.visitorProject ? '' : (jobTitle || ''), company: project.visitorProject ? (company || '') : '', nfcId: null, addedAt: new Date().toISOString() };
  project.people.push(person);
  savePeople(peopleData);
  res.json({ success: true, person, projectName: project.name });
});

// ── Assign NFC card to person ────────────────────────────────
app.put('/api/people/:personId/nfc', (req, res) => {
  const { nfcId } = req.body;
  if (!nfcId) return res.status(400).json({ error: 'nfcId required' });

  // Check not already assigned to someone else
  const existing = findPersonByNfc(nfcId);
  if (existing && existing.person.id !== req.params.personId) {
    return res.status(409).json({ error: `Card already assigned to ${existing.person.name}` });
  }

  let found = false;
  for (const proj of peopleData.projects) {
    const person = proj.people.find(p => p.id === req.params.personId);
    if (person) { person.nfcId = nfcId; found = true; break; }
  }
  if (!found) return res.status(404).json({ error: 'Person not found' });
  savePeople(peopleData);
  res.json({ success: true });
});

// ── Remove NFC card from person ──────────────────────────────
app.delete('/api/people/:personId/nfc', (req, res) => {
  let found = false;
  for (const proj of peopleData.projects) {
    const person = proj.people.find(p => p.id === req.params.personId);
    if (person) { person.nfcId = null; found = true; break; }
  }
  if (!found) return res.status(404).json({ error: 'Person not found' });
  savePeople(peopleData);
  res.json({ success: true });
});

// ── NFC tap — sign in or out automatically ───────────────────
app.post('/api/nfc-tap', (req, res) => {
  const { nfcId } = req.body;
  if (!nfcId) return res.status(400).json({ error: 'nfcId required' });

  const match = findPersonByNfc(nfcId);
  if (!match) return res.status(404).json({ error: 'Card not recognised' });

  const { person, project } = match;

  // Toggle: if signed in → sign out, else → sign in
  const signedInIndex = signinData.currentVisitors.findIndex(
    v => v.personId === person.id || v.name.toLowerCase() === person.name.toLowerCase()
  );

  if (signedInIndex !== -1) {
    // Sign out
    const visitor = signinData.currentVisitors[signedInIndex];
    visitor.timeOut = new Date().toISOString();
    signinData.history.unshift(visitor);
    signinData.currentVisitors.splice(signedInIndex, 1);
    saveSigninData(signinData);
    io.emit('update', signinData.currentVisitors);
    return res.json({ success: true, action: 'signout', name: person.name });
  } else {
    // Sign in
    const visitor = { personId: person.id, name: person.name, jobTitle: person.jobTitle || '', project: project.name, timeIn: new Date().toISOString() };
    signinData.currentVisitors.push(visitor);
    saveSigninData(signinData);
    io.emit('update', signinData.currentVisitors);
    return res.json({ success: true, action: 'signin', name: person.name });
  }
});

app.delete('/api/people/:personId', (req, res) => {
  let found = false;
  peopleData.projects.forEach(proj => {
    const idx = proj.people.findIndex(p => p.id === req.params.personId);
    if (idx !== -1) { proj.people.splice(idx, 1); found = true; }
  });
  if (!found) return res.status(404).json({ error: 'Person not found' });
  savePeople(peopleData);
  res.json({ success: true });
});

app.post('/api/projects', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required' });
  if (peopleData.projects.some(p => p.name.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'Project already exists' });
  const project = { id: uid(), name, visitorProject: false, suspended: false, people: [] };
  peopleData.projects.push(project);
  savePeople(peopleData);
  res.json({ success: true, project });
});

app.delete('/api/projects/:projectId', (req, res) => {
  const idx = peopleData.projects.findIndex(p => p.id === req.params.projectId);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  peopleData.projects.splice(idx, 1);
  savePeople(peopleData);
  res.json({ success: true });
});

// ── Suspend / unsuspend project ──────────────────────────────
app.put('/api/projects/:projectId/suspend', (req, res) => {
  const project = peopleData.projects.find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  project.suspended = !project.suspended;
  savePeople(peopleData);
  io.emit('people-update', peopleData);
  res.json({ success: true, suspended: project.suspended });
});

// ── Notice API ───────────────────────────────────────────────
const NOTICE_FILE = path.join(__dirname, 'notice.json');

function loadNotice() {
  try { if (fs.existsSync(NOTICE_FILE)) return JSON.parse(fs.readFileSync(NOTICE_FILE, 'utf8')); } catch (e) {}
  return { text: '', updatedAt: null };
}
function saveNotice(d) { fs.writeFileSync(NOTICE_FILE, JSON.stringify(d, null, 2)); }

let noticeData = loadNotice();

// Auto-clear notice at midnight
function scheduleNoticeClear() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 2, 0);
  setTimeout(() => {
    noticeData = { text: '', updatedAt: null };
    saveNotice(noticeData);
    io.emit('notice-update', noticeData);
    scheduleNoticeClear();
  }, midnight - now);
}
scheduleNoticeClear();

app.get('/api/notice', (req, res) => res.json(noticeData));

app.post('/api/notice', (req, res) => {
  const { text } = req.body;
  noticeData = { text: text || '', updatedAt: text ? new Date().toISOString() : null };
  saveNotice(noticeData);
  io.emit('notice-update', noticeData);
  res.json({ success: true, notice: noticeData });
});

app.get('/api/visitors', (req, res) => res.json(signinData.currentVisitors));
app.get('/api/history',  (req, res) => res.json(signinData.history));

// ── History for a specific person (all time) ──────────────────
app.get('/api/history/person/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name).toLowerCase();
  const entries = signinData.history.filter(v => v.name.toLowerCase() === name);
  res.json(entries);
});

app.post('/api/signin', (req, res) => {
  const { personId, name, jobTitle, project } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (signinData.currentVisitors.find(v => v.name.toLowerCase() === name.toLowerCase()))
    return res.status(409).json({ error: 'Already signed in' });
  const visitor = { personId: personId || null, name, jobTitle: jobTitle || '', project: project || '', timeIn: new Date().toISOString() };
  signinData.currentVisitors.push(visitor);
  saveSigninData(signinData);
  io.emit('update', signinData.currentVisitors);
  res.json({ success: true, visitor });
});

app.post('/api/signout', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const index = signinData.currentVisitors.findIndex(v => v.name.toLowerCase() === name.toLowerCase());
  if (index === -1) return res.status(404).json({ error: 'Not signed in' });
  const visitor = signinData.currentVisitors[index];
  visitor.timeOut = new Date().toISOString();
  signinData.history.unshift(visitor);
  signinData.currentVisitors.splice(index, 1);
  saveSigninData(signinData);
  io.emit('update', signinData.currentVisitors);
  res.json({ success: true, visitor });
});

app.delete('/api/clear', (req, res) => {
  signinData.currentVisitors = [];
  saveSigninData(signinData);
  io.emit('update', signinData.currentVisitors);
  res.json({ success: true });
});

// ── Auto signout scheduler ──────────────────────────────────
function scheduleAutoSignout() {
  const now = new Date();

  // Midnight: sign out everyone except ShopOn
  const midnight = new Date(now);
  midnight.setHours(24, 0, 5, 0);
  setTimeout(() => {
    signinData.currentVisitors = signinData.currentVisitors.filter(v => {
      const isShopOn = v.project && v.project.toLowerCase().includes('shopon');
      if (!isShopOn) {
        v.timeOut = new Date().toISOString();
        signinData.history.unshift(v);
      }
      return isShopOn;
    });
    // Purge history entries from before today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    signinData.history = signinData.history.filter(v => {
      const t = v.timeIn ? new Date(v.timeIn).getTime() : 0;
      return t >= todayStart.getTime();
    });
    saveSigninData(signinData);
    io.emit('update', signinData.currentVisitors);
    scheduleAutoSignout();
  }, midnight - now);

  // 6am: sign out ShopOn staff
  const sixAm = new Date(now);
  sixAm.setHours(6, 0, 5, 0);
  if (sixAm <= now) sixAm.setDate(sixAm.getDate() + 1);
  setTimeout(() => {
    signinData.currentVisitors = signinData.currentVisitors.filter(v => {
      const isShopOn = v.project && v.project.toLowerCase().includes('shopon');
      if (isShopOn) {
        v.timeOut = new Date().toISOString();
        signinData.history.unshift(v);
      }
      return !isShopOn;
    });
    saveSigninData(signinData);
    io.emit('update', signinData.currentVisitors);
  }, sixAm - now);
}
scheduleAutoSignout();

// Filter suspended projects from people list for sign-in pages
app.get('/api/people/active', (req, res) => {
  const active = {
    projects: peopleData.projects
      .filter(p => !p.suspended)
      .map(p => ({ ...p }))
  };
  res.json(active);
});

io.on('connection', socket => {
  socket.emit('update', signinData.currentVisitors);
  socket.emit('notice-update', noticeData);
  socket.emit('people-update', peopleData);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Versa Manchester running on port ${PORT}`));
