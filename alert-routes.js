// =====================================================================
// VERSA ALERT — Express routes
//
// Add to server.js:
//     const alertRoutes = require('./alert-routes');
//     app.use('/api/alert', alertRoutes(supabase));
//
// SCHEMA (versa-signin):
//   visitors  = the sign-in log. One row per sign-in.
//               id, site, person_id, name, job_title, project,
//               time_in, time_out, created_at, phone
//               On site  ==  site matches AND time_out IS NULL
//   people    = the roster, keyed to projects.
//               id, project_id, name, job_title, company, nfc_id,
//               added_at, email, phone, person_type, job_ref
//               visitors.person_id -> people.id
//
// A number is looked up on the visitor row first (typed at sign-in),
// then falls back to the roster. Roster is the durable store: typed
// once when someone is added, reused on every future visit.
//
// PHASE 1: roll call only — no Twilio account, no npm install.
// PHASE 2: npm install twilio + env vars, and /send switches itself on.
// =====================================================================

const express = require('express');

let twilio = null;
try {
    twilio = require('twilio');
} catch (e) {
    console.warn('[alert] twilio package not installed — roll call active, SMS disabled');
}

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const FROM          = process.env.TWILIO_FROM;
const MESSAGING_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || null;

const client = (twilio && ACCOUNT_SID && AUTH_TOKEN)
    ? twilio(ACCOUNT_SID, AUTH_TOKEN)
    : null;

const SMS_ENABLED = !!(client && (MESSAGING_SID || FROM));
if (!SMS_ENABLED) console.warn('[alert] SMS disabled — set TWILIO_* env vars to enable');


// ---------------------------------------------------------------------
// Message templates — keep identical to TEXT in alert.html
// ---------------------------------------------------------------------

// Tap this once on your own phone before go-live and check it lands on
// the right park — there is also a St John's Gardens in Liverpool.
// To pin it exactly: https://maps.google.com/?q=53.4774,-2.2527
const MAP = 'https://maps.google.com/?q=St+Johns+Gardens+Manchester';

const PREFIX = site => `VERSA ${site.toUpperCase()}: `;
const CUSTOM_LIMIT = 142;

const TEMPLATES = {
    evacuate: site =>
        `VERSA ${site.toUpperCase()}. LEAVE BY THE NEAREST EXIT AND ASSEMBLE AT ST JOHNS GARDENS. MAP: ${MAP}`,

    all_clear: site =>
        `VERSA ${site.toUpperCase()}. YOU ARE NOW FREE TO RE-ENTER THE BUILDING.`
};

const LABELS = { evacuate:'Evacuate', all_clear:'All clear', custom:'Custom message' };


// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toE164(raw) {
    if (!raw) return null;
    const n = String(raw).replace(/[^\d+]/g, '');
    if (n.startsWith('+44') && n.length === 13) return n;
    if (n.startsWith('44')  && n.length === 12) return '+' + n;
    if (n.startsWith('07')  && n.length === 11) return '+44' + n.slice(1);
    if (n.startsWith('+'))  return n;
    return null;
}

function gsm7(text) {
    return String(text)
        .replace(/[\u2018\u2019\u201B]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2013\u2014]/g, '-')
        .replace(/\u2026/g, '...')
        .replace(/[^\x20-\x7E\n]/g, '');
}

async function sendBatched(numbers, body, batchSize = 20) {
    let accepted = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < numbers.length; i += batchSize) {
        const batch = numbers.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(to => {
            const payload = { to, body };
            if (MESSAGING_SID) payload.messagingServiceSid = MESSAGING_SID;
            else payload.from = FROM;
            return client.messages.create(payload);
        }));

        results.forEach((r, idx) => {
            if (r.status === 'fulfilled') accepted++;
            else {
                failed++;
                if (errors.length < 10) errors.push({ to: batch[idx], error: r.reason?.message });
            }
        });
    }
    return { accepted, failed, errors };
}


module.exports = function alertRoutes(supabase) {
    const router = express.Router();

    router.use('/inbound', express.urlencoded({ extended: false }));
    router.use(express.json());

    const lastSend = {};

    function locked(site) {
        const last = lastSend[site];
        if (!last) return 0;
        const remaining = 60000 - (Date.now() - last);
        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }


    // -----------------------------------------------------------------
    // Everyone currently signed in at a site.
    // Two queries rather than a join, because person_id -> people.id
    // may not have a declared foreign key for PostgREST to follow.
    // -----------------------------------------------------------------
    async function getOnSite(site) {
        const { data: rows, error } = await supabase
            .from('visitors')
            .select('id, name, person_id, phone, job_title, project, time_in')
            .eq('site', site)
            .is('time_out', null);

        if (error) throw error;
        if (!rows || !rows.length) return [];

        // Pull roster numbers for anyone linked to a people record.
        const ids = [...new Set(rows.map(r => r.person_id).filter(Boolean))];
        const roster = {};

        if (ids.length) {
            const { data: ppl, error: pErr } = await supabase
                .from('people')
                .select('id, phone, alert_optout')
                .in('id', ids);
            if (pErr) throw pErr;
            (ppl || []).forEach(p => { roster[p.id] = p; });
        }

        return rows.map(r => {
            const person = roster[r.person_id] || {};
            return {
                id:        r.id,                                  // visitors row id
                person_id: r.person_id || null,
                name:      r.name,
                job_title: r.job_title || null,
                project:   r.project || null,
                time_in:   r.time_in,
                phone:     r.phone || person.phone || null,       // sign-in first, roster second
                optout:    !!person.alert_optout
            };
        });
    }


    async function verifyPin(pin, site) {
        const { data } = await supabase
            .from('alert_senders')
            .select('name, site')
            .eq('pin', String(pin))
            .eq('active', true);
        if (!data || !data.length) return null;
        return data.find(s => !s.site || s.site === site) || null;
    }


    // =================================================================
    // PHASE 1 — works with no Twilio account
    // =================================================================

    router.get('/status', (req, res) => {
        res.json({ sms: SMS_ENABLED });
    });


    router.get('/headcount', async (req, res) => {
        try {
            const site = req.query.site;
            if (!site) return res.status(400).json({ error: 'site required' });

            const onSite = await getOnSite(site);
            const reachable = onSite.filter(p => !p.optout && toE164(p.phone));

            res.json({
                site,
                onSite: onSite.length,
                reachable: reachable.length,
                noNumber: onSite.length - reachable.length,
                lockout: locked(site)
            });
        } catch (e) {
            console.error('[alert] headcount:', e.message);
            res.status(500).json({ error: e.message });
        }
    });


    // The roll call at the assembly point.
    router.get('/roll', async (req, res) => {
        try {
            const site = req.query.site;
            if (!site) return res.status(400).json({ error: 'site required' });

            const onSite = await getOnSite(site);
            res.json({
                site,
                total: onSite.length,
                people: onSite
                    .map(p => ({
                        id:       p.id,
                        name:     p.name,
                        detail:   p.project || p.job_title || null,
                        hasPhone: !!toE164(p.phone)
                    }))
                    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
            });
        } catch (e) {
            console.error('[alert] roll:', e.message);
            res.status(500).json({ error: e.message });
        }
    });


    // Sign one person off. Anyone left on the roll is unaccounted for.
    // id is the visitors row id, which is what /roll returns.
    router.post('/signout', async (req, res) => {
        try {
            const { pin, site, id } = req.body;
            if (!id)   return res.status(400).json({ error: 'id required' });
            if (!site) return res.status(400).json({ error: 'site required' });

            const sender = await verifyPin(pin, site);
            if (!sender) return res.status(401).json({ error: 'PIN not recognised' });

            const { error } = await supabase
                .from('visitors')
                .update({ time_out: new Date().toISOString() })
                .eq('id', id)
                .is('time_out', null);

            if (error) return res.status(500).json({ error: error.message });
            res.json({ ok: true, by: sender.name });
        } catch (e) {
            console.error('[alert] signout:', e.message);
            res.status(500).json({ error: e.message });
        }
    });


    router.get('/log', async (req, res) => {
        const { data, error } = await supabase
            .from('alert_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    });


    // =================================================================
    // PHASE 2 — switches on once Twilio is configured
    // =================================================================

    router.post('/send', async (req, res) => {
        try {
            if (!SMS_ENABLED) {
                return res.status(503).json({
                    error: 'SMS is not switched on yet. Nothing has been sent.'
                });
            }

            const { pin, site, type, test, message: custom } = req.body;

            if (type !== 'custom' && !TEMPLATES[type]) {
                return res.status(400).json({ error: 'Unknown alert type' });
            }
            if (!site) return res.status(400).json({ error: 'Site required' });

            // Never trust the client to have sanitised or truncated this.
            let customClean = null;
            if (type === 'custom') {
                customClean = gsm7(String(custom || '').trim()).slice(0, CUSTOM_LIMIT);
                if (customClean.length < 5) {
                    return res.status(400).json({ error: 'Message is too short' });
                }
            }

            const sender = await verifyPin(pin, site);
            if (!sender) return res.status(401).json({ error: 'PIN not recognised' });

            const wait = locked(site);
            if (wait && !test) {
                return res.status(429).json({ error: `Alert sent recently. Wait ${wait}s.` });
            }

            const message = type === 'custom'
                ? PREFIX(site) + customClean
                : gsm7(TEMPLATES[type](site));

            const onSite = await getOnSite(site);

            let numbers;
            if (test) {
                const { data } = await supabase
                    .from('alert_senders')
                    .select('phone').eq('active', true).not('phone', 'is', null);
                numbers = (data || []).map(s => toE164(s.phone)).filter(Boolean);
            } else {
                numbers = [...new Set(onSite
                    .filter(p => !p.optout)
                    .map(p => toE164(p.phone))
                    .filter(Boolean))];
            }

            if (!numbers.length) {
                return res.status(400).json({ error: 'No valid mobile numbers to send to' });
            }

            if (!test) lastSend[site] = Date.now();

            // Respond immediately — the phone must not sit on a spinner
            // while the messages go out.
            res.json({
                sending: true,
                recipients: numbers.length,
                onSite: onSite.length,
                message,
                test: !!test
            });

            const body = test ? `[TEST] ${message}` : message;
            const result = await sendBatched(numbers, body);

            await supabase.from('alert_log').insert({
                site,
                alert_type: type,
                message: body,
                triggered_by: sender.name,
                trigger_method: 'web',
                is_test: !!test,
                recipients: numbers.length,
                accepted: result.accepted,
                failed: result.failed,
                on_site_count: onSite.length
            });

            if (result.failed) console.error('[alert] failures:', result.errors);

        } catch (e) {
            console.error('[alert] send error:', e);
            if (!res.headersSent) res.status(500).json({ error: e.message });
        }
    });


    router.post('/inbound', async (req, res) => {
        if (!SMS_ENABLED) return res.status(503).send('SMS not configured');

        const twiml = new twilio.twiml.MessagingResponse();

        try {
            // Without this check, anyone who finds the URL can trigger a
            // site-wide evacuation text.
            const signature = req.headers['x-twilio-signature'];
            const url = 'https://' + req.get('host') + req.originalUrl;

            if (!twilio.validateRequest(AUTH_TOKEN, signature, url, req.body)) {
                console.error('[alert] inbound: bad Twilio signature');
                return res.status(403).send('Forbidden');
            }

            const from = toE164(req.body.From);
            const text = String(req.body.Body || '').trim().toUpperCase();

            const { data: senders } = await supabase
                .from('alert_senders')
                .select('name, site')
                .eq('phone', from)
                .eq('active', true);

            if (!senders || !senders.length) {
                twiml.message('Number not authorised to send alerts.');
                return res.type('text/xml').send(twiml.toString());
            }
            const sender = senders[0];

            const TYPES = { EVAC:'evacuate', CLEAR:'all_clear' };
            const SITES = { MCR:'Manchester', MAN:'Manchester' };

            const [word, siteCode] = text.split(/\s+/);
            const type = TYPES[word];
            const site = SITES[siteCode];

            if (!type || !site) {
                twiml.message('Format: EVAC MCR or CLEAR MCR');
                return res.type('text/xml').send(twiml.toString());
            }
            if (sender.site && sender.site !== site) {
                twiml.message(`Not authorised for ${site}.`);
                return res.type('text/xml').send(twiml.toString());
            }

            const wait = locked(site);
            if (wait) {
                twiml.message(`Alert sent recently. Wait ${wait}s.`);
                return res.type('text/xml').send(twiml.toString());
            }

            const message = gsm7(TEMPLATES[type](site));
            const onSite  = await getOnSite(site);
            const numbers = [...new Set(onSite
                .filter(p => !p.optout)
                .map(p => toE164(p.phone))
                .filter(Boolean))];

            if (!numbers.length) {
                twiml.message('No valid numbers on site. Alert NOT sent.');
                return res.type('text/xml').send(twiml.toString());
            }

            lastSend[site] = Date.now();
            twiml.message(`${LABELS[type]} sending to ${numbers.length} of ${onSite.length} on site.`);
            res.type('text/xml').send(twiml.toString());

            const result = await sendBatched(numbers, message);

            await supabase.from('alert_log').insert({
                site, alert_type: type, message,
                triggered_by: sender.name,
                trigger_method: 'sms',
                recipients: numbers.length,
                accepted: result.accepted,
                failed: result.failed,
                on_site_count: onSite.length
            });

            await client.messages.create({
                to: from,
                ...(MESSAGING_SID ? { messagingServiceSid: MESSAGING_SID } : { from: FROM }),
                body: `Sent: ${result.accepted} delivered to carrier, ${result.failed} failed.`
            });

        } catch (e) {
            console.error('[alert] inbound error:', e);
            if (!res.headersSent) {
                twiml.message('Alert failed. Use the web page or PA system.');
                res.type('text/xml').send(twiml.toString());
            }
        }
    });

    return router;
};
