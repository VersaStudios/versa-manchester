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

// Allow the monitor site to fetch data from this server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
          { id: 'p1',  name: 'Andrew Rowell',  jobTitle: 'Technical Manager' },
          { id: 'p2',  name: 'Lily Britten',   jobTitle: 'Assistant Studio Manager' },
          { id: 'p3',  name: 'Chris Warden',   jobTitle: 'Group Head of Operations and Technology' },
          { id: 'p4',  name: 'Esther Brazil',  jobTitle: 'Assistant Operations Manager' },
          { id: 'p5',  name: 'Ian Curry',      jobTitle: 'Broadcast Engineer' },
          { id: 'p6',  name: 'Ed Harvey',      jobTitle: 'Head of Studio' },
          { id: 'p7',  name: 'Ben Riding',     jobTitle: 'Finance Manager' }
        ]
      },
      {
        id: 'versa-freelance', name: 'Versa Freelance Crew', visitorProject: false,
        people: [
          { id: 'p8',  name: 'Howard Knock',    jobTitle: 'Sound Guarantee' },
          { id: 'p9',  name: 'Andy McLannahan', jobTitle: 'Studio Engineer' },
          { id: 'p10', name: 'Mark Openshaw',   jobTitle: 'Ingest' },
          { id: 'p11', name: 'Simon Blunt',     jobTitle: 'Technical Manager' },
          { id: 'p12', name: 'Oliver Riches',   jobTitle: 'Technical Manager' }
        ]
      },
      { id: 'shopon-tv',   name: 'ShopOn TV',    visitorProject: false, people: [{ id: 'p13', name: 'Rob Locke', jobTitle: 'Head of Television / Presenter' }] },
      { id: 'dragons-den', name: 'Dragons Den',  visitorProject: false, people: [] },
      { id: 'visitor',     name: 'Visitor',      visitorProject: true,  people: [] }
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

  // Also purge visitor history older than 7 days
  const histBefore = signinData.history.length;
  signinData.history = signinData.history.filter(v => {
    if (v.project !== 'Visitor') return true;
    const t = v.timeIn ? new Date(v.timeIn).getTime() : 0;
    return t > cutoff;
  });
  if (signinData.history.length !== histBefore) saveSigninData(signinData);
}

// Run purge on startup and every hour
purgeOldVisitors();
setInterval(purgeOldVisitors, 60 * 60 * 1000);

// ── People API ───────────────────────────────────────────────
app.get('/api/people', (req, res) => res.json(peopleData));

app.post('/api/people', (req, res) => {
  const { name, jobTitle, projectId } = req.body;
  if (!name || !projectId) return res.status(400).json({ error: 'Name and projectId required' });

  const project = peopleData.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Visitors: no duplicate check, no job title
  if (!project.visitorProject) {
    const dup = peopleData.projects.some(proj => proj.people.some(p => p.name.toLowerCase() === name.toLowerCase()));
    if (dup) return res.status(409).json({ error: 'Name already exists' });
  }

  const person = { id: uid(), name, jobTitle: project.visitorProject ? '' : (jobTitle || ''), addedAt: new Date().toISOString() };
  project.people.push(person);
  savePeople(peopleData);
  res.json({ success: true, person, projectName: project.name });
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
  const project = { id: uid(), name, visitorProject: false, people: [] };
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

// ── Sign In / Out API ────────────────────────────────────────
app.get('/api/visitors', (req, res) => res.json(signinData.currentVisitors));
app.get('/api/history',  (req, res) => res.json(signinData.history));

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

io.on('connection', socket => socket.emit('update', signinData.currentVisitors));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Versa Manchester running on port ${PORT}`));
