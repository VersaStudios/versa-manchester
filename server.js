const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

const SITE = 'manchester';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Default people (first run) ───────────────────────────────
async function seedDefaultPeople() {
  const { data } = await supabase.from('projects').select('id').eq('site', SITE).limit(1);
  if (data && data.length > 0) return; // already seeded

  const projects = [
    { id: 'versa-staff-mcr',     site: SITE, name: 'Versa Staff',          visitor_project: false },
    { id: 'versa-freelance-mcr', site: SITE, name: 'Versa Freelance Crew', visitor_project: false },
    { id: 'shopon-tv-mcr',       site: SITE, name: 'ShopOn TV',            visitor_project: false },
    { id: 'dragons-den-mcr',     site: SITE, name: 'Dragons Den',          visitor_project: false },
    { id: 'silverscape-mcr',     site: SITE, name: 'Silverscape',          visitor_project: false },
    { id: 'visitor-mcr',         site: SITE, name: 'Visitor',              visitor_project: true  },
  ];
  await supabase.from('projects').insert(projects);

  const people = [
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Andrew Rowell',  job_title: 'Technical Manager' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Lily Britten',   job_title: 'Assistant Studio Manager' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Chris Warden',   job_title: 'Group Head of Operations and Technology' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Esther Brazil',  job_title: 'Assistant Operations Manager' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Ian Curry',      job_title: 'Broadcast Engineer' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Ed Harvey',      job_title: 'Head of Studio' },
    { id: uid(), project_id: 'versa-staff-mcr', name: 'Ben Riding',     job_title: 'Finance Manager' },
    { id: uid(), project_id: 'versa-freelance-mcr', name: 'Howard Knock',    job_title: 'Sound Guarantee' },
    { id: uid(), project_id: 'versa-freelance-mcr', name: 'Andy McLannahan', job_title: 'Studio Engineer' },
    { id: uid(), project_id: 'versa-freelance-mcr', name: 'Mark Openshaw',   job_title: 'Ingest' },
    { id: uid(), project_id: 'versa-freelance-mcr', name: 'Simon Blunt',     job_title: 'Technical Manager' },
    { id: uid(), project_id: 'versa-freelance-mcr', name: 'Oliver Riches',   job_title: 'Technical Manager' },
    { id: uid(), project_id: 'shopon-tv-mcr',    name: 'Rob Locke', job_title: 'Head of Television / Presenter' },
  ];
  await supabase.from('people').insert(people);
  console.log('Seeded default people for Manchester');
}
seedDefaultPeople().catch(console.error);

// ── Helper: build peopleData structure ──────────────────────
async function getPeopleData(activeOnly = false) {
  let projQuery = supabase.from('projects').select('*, people(*)').eq('site', SITE);
  if (activeOnly) projQuery = projQuery.eq('suspended', false);
  const { data, error } = await projQuery;
  if (error) throw error;
  return {
    projects: data.map(p => ({
      id: p.id, name: p.name, visitorProject: p.visitor_project,
      suspended: p.suspended,
      people: (p.people || []).map(person => ({
        id: person.id, name: person.name, jobTitle: person.job_title,
        company: person.company, nfcId: person.nfc_id, addedAt: person.added_at
      }))
    }))
  };
}

// ── Helper: get current visitors ────────────────────────────
async function getCurrentVisitors() {
  const { data, error } = await supabase.from('visitors')
    .select('*').eq('site', SITE).is('time_out', null);
  if (error) throw error;
  return data.map(v => ({
    id: v.id, personId: v.person_id, name: v.name,
    jobTitle: v.job_title, project: v.project, timeIn: v.time_in
  }));
}

// ── Helper: get today's history ─────────────────────────────
async function getTodayHistory() {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const { data, error } = await supabase.from('visitors')
    .select('*').eq('site', SITE)
    .not('time_out', 'is', null)
    .gte('time_in', todayStart.toISOString())
    .order('time_out', { ascending: false });
  if (error) throw error;
  return data.map(v => ({
    id: v.id, personId: v.person_id, name: v.name,
    jobTitle: v.job_title, project: v.project,
    timeIn: v.time_in, timeOut: v.time_out
  }));
}

// ── People API ───────────────────────────────────────────────
app.get('/api/people', async (req, res) => {
  try { res.json(await getPeopleData()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/active', async (req, res) => {
  try { res.json(await getPeopleData(true)); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/people', async (req, res) => {
  const { name, jobTitle, projectId, company } = req.body;
  if (!name || !projectId) return res.status(400).json({ error: 'Name and projectId required' });
  const { data: proj } = await supabase.from('projects').select('*').eq('id', projectId).single();
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const person = { id: uid(), project_id: projectId, name, job_title: proj.visitor_project ? '' : (jobTitle||''), company: proj.visitor_project ? (company||'') : '', added_at: new Date().toISOString() };
  await supabase.from('people').insert(person);
  res.json({ success: true, person: { id: person.id, name, jobTitle: person.job_title }, projectName: proj.name });
});

app.delete('/api/people/:personId', async (req, res) => {
  const { error } = await supabase.from('people').delete().eq('id', req.params.personId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.put('/api/people/:personId', async (req, res) => {
  const { name, jobTitle } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  await supabase.from('people').update({ name, job_title: jobTitle||'' }).eq('id', req.params.personId);
  const peopleData = await getPeopleData();
  io.emit('people-update', peopleData);
  res.json({ success: true });
});

app.put('/api/people/:personId/nfc', async (req, res) => {
  const { nfcId } = req.body;
  if (!nfcId) return res.status(400).json({ error: 'nfcId required' });
  const { data: existing } = await supabase.from('people').select('id, name').eq('nfc_id', nfcId).limit(1);
  if (existing && existing.length > 0 && existing[0].id !== req.params.personId)
    return res.status(409).json({ error: `Card already assigned to ${existing[0].name}` });
  await supabase.from('people').update({ nfc_id: nfcId }).eq('id', req.params.personId);
  res.json({ success: true });
});

app.delete('/api/people/:personId/nfc', async (req, res) => {
  await supabase.from('people').update({ nfc_id: null }).eq('id', req.params.personId);
  res.json({ success: true });
});

// ── Projects API ─────────────────────────────────────────────
app.post('/api/projects', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required' });
  const { data: existing } = await supabase.from('projects').select('id').eq('site', SITE).ilike('name', name).limit(1);
  if (existing && existing.length > 0) return res.status(409).json({ error: 'Project already exists' });
  const project = { id: uid(), site: SITE, name, visitor_project: false, suspended: false };
  await supabase.from('projects').insert(project);
  res.json({ success: true, project: { id: project.id, name, visitorProject: false, suspended: false, people: [] } });
});

app.delete('/api/projects/:projectId', async (req, res) => {
  await supabase.from('projects').delete().eq('id', req.params.projectId);
  res.json({ success: true });
});

app.put('/api/projects/:projectId/suspend', async (req, res) => {
  const { data: proj } = await supabase.from('projects').select('suspended').eq('id', req.params.projectId).single();
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const suspended = !proj.suspended;
  await supabase.from('projects').update({ suspended }).eq('id', req.params.projectId);
  const peopleData = await getPeopleData();
  io.emit('people-update', peopleData);
  res.json({ success: true, suspended });
});

// ── NFC tap ──────────────────────────────────────────────────
app.post('/api/nfc-tap', async (req, res) => {
  const { nfcId } = req.body;
  if (!nfcId) return res.status(400).json({ error: 'nfcId required' });
  const { data: people } = await supabase.from('people').select('*, projects(name)').eq('nfc_id', nfcId).limit(1);
  if (!people || people.length === 0) return res.status(404).json({ error: 'Card not recognised' });
  const person = people[0];
  const projectName = person.projects ? person.projects.name : '';
  const { data: signedIn } = await supabase.from('visitors').select('id').eq('site', SITE).eq('person_id', person.id).is('time_out', null).limit(1);
  if (signedIn && signedIn.length > 0) {
    await supabase.from('visitors').update({ time_out: new Date().toISOString() }).eq('id', signedIn[0].id);
    io.emit('update', await getCurrentVisitors());
    return res.json({ success: true, action: 'signout', name: person.name });
  } else {
    await supabase.from('visitors').insert({ id: uid(), site: SITE, person_id: person.id, name: person.name, job_title: person.job_title||'', project: projectName, time_in: new Date().toISOString() });
    io.emit('update', await getCurrentVisitors());
    return res.json({ success: true, action: 'signin', name: person.name });
  }
});

// ── Sign in / out ────────────────────────────────────────────
app.get('/api/visitors', async (req, res) => {
  try { res.json(await getCurrentVisitors()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
  try { res.json(await getTodayHistory()); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/person/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const { data } = await supabase.from('visitors').select('*').eq('site', SITE).ilike('name', name).not('time_out', 'is', null).order('time_in', { ascending: false });
  res.json((data||[]).map(v => ({ id: v.id, name: v.name, jobTitle: v.job_title, project: v.project, timeIn: v.time_in, timeOut: v.time_out })));
});

app.post('/api/signin', async (req, res) => {
  const { personId, name, jobTitle, project } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const visitor = { id: uid(), site: SITE, person_id: personId||null, name, job_title: jobTitle||'', project: project||'', time_in: new Date().toISOString() };
  const { error } = await supabase.from('visitors').insert(visitor);
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Already signed in' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, visitor });
  // Emit update in background - don't block the response
  getCurrentVisitors().then(v => io.emit('update', v)).catch(()=>{});
});

app.post('/api/signout', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const { data } = await supabase.from('visitors').select('id').eq('site', SITE).ilike('name', name).is('time_out', null).limit(1);
  if (!data || data.length === 0) return res.status(404).json({ error: 'Not signed in' });
  await supabase.from('visitors').update({ time_out: new Date().toISOString() }).eq('id', data[0].id);
  res.json({ success: true });
  // Emit update in background
  getCurrentVisitors().then(v => io.emit('update', v)).catch(()=>{});
});

app.delete('/api/clear', async (req, res) => {
  await supabase.from('visitors').update({ time_out: new Date().toISOString() }).eq('site', SITE).is('time_out', null);
  io.emit('update', []);
  res.json({ success: true });
});

// ── Notice API ───────────────────────────────────────────────
app.get('/api/notice', async (req, res) => {
  const { data } = await supabase.from('notices').select('*').eq('site', SITE).single();
  res.json(data || { text: '', updated_at: null });
});

app.post('/api/notice', async (req, res) => {
  const { text } = req.body;
  const updated = { text: text||'', updated_at: text ? new Date().toISOString() : null };
  await supabase.from('notices').upsert({ site: SITE, ...updated });
  io.emit('notice-update', updated);
  res.json({ success: true, notice: updated });
});

// ── Socket.io ────────────────────────────────────────────────
io.on('connection', async socket => {
  try {
    socket.emit('update', await getCurrentVisitors());
    const { data: notice } = await supabase.from('notices').select('*').eq('site', SITE).single();
    socket.emit('notice-update', notice || { text: '' });
    socket.emit('people-update', await getPeopleData());
  } catch(e) {}
});

// ── Auto signout ─────────────────────────────────────────────
function scheduleAutoSignout() {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 10, 0);
  setTimeout(async () => {
    const current = await getCurrentVisitors();
    for (const v of current) {
      const isShopOn = v.project && v.project.toLowerCase().includes('shopon');
      if (!isShopOn) await supabase.from('visitors').update({ time_out: new Date().toISOString() }).eq('id', v.id);
    }
    io.emit('update', await getCurrentVisitors());
    scheduleAutoSignout();
  }, midnight - now);

  const sixAm = new Date(now); sixAm.setHours(6, 0, 10, 0);
  if (sixAm <= now) sixAm.setDate(sixAm.getDate() + 1);
  setTimeout(async () => {
    const current = await getCurrentVisitors();
    for (const v of current) {
      const isShopOn = v.project && v.project.toLowerCase().includes('shopon');
      if (isShopOn) await supabase.from('visitors').update({ time_out: new Date().toISOString() }).eq('id', v.id);
    }
    io.emit('update', await getCurrentVisitors());
  }, sixAm - now);
}
scheduleAutoSignout();

// ── Auto clear notice at midnight ────────────────────────────
function scheduleNoticeClear() {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 2, 0);
  setTimeout(async () => {
    await supabase.from('notices').update({ text: '', updated_at: null }).eq('site', SITE);
    io.emit('notice-update', { text: '' });
    scheduleNoticeClear();
  }, midnight - now);
}
scheduleNoticeClear();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Versa Manchester running on port ${PORT}`));
