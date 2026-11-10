// Deterministic synthetic estate for phase 3 (scale). `node scale.mjs` writes corpus/scale.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const R = rng(20261110);
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const PROJECT_NAMES = ['Fjällräv', 'Ask', 'Björk', 'Dovhjort', 'Ekorre', 'Falk', 'Gädda', 'Hermelin', 'Igelkott', 'Järv', 'Kråka', 'Lärka', 'Mård', 'Näktergal', 'Orre', 'Pilgrimsfalk', 'Rådjur', 'Sälg', 'Tjäder', 'Uv', 'Vildsvin', 'Älg', 'Örn', 'Bäver', 'Duvhök', 'Fiskmås', 'Gråsparv', 'Hackspett', 'Isbjörn', 'Jorduggla', 'Kungsörn', 'Lodmott', 'Murmeldjur', 'Nötväcka', 'Ormvråk', 'Pärluggla', 'Rapphöna', 'Skata', 'Trana', 'Vessla'];
const CLIENTS = ['Tallbacka Kommun', 'Norrsken Logistik', 'Grönhaga Energi', 'Sjövik Försäkring', 'Bergsli Bygg', 'Ljusdal Medtech', 'Strandviks Rederi', 'Ekholm Retail', 'Vintergatan Media', 'Dalstorp Livs'];
const PEOPLE = [
  ['Ingrid Sjöberg', 'lead consultant'], ['Oskar Lindmark', 'data engineer'], ['Maja Holmqvist', 'project manager'],
  ['Erik Fahlén', 'solution architect'], ['Sara Nyborg', 'UX lead'], ['Johan Rask', 'ML engineer'],
  ['Lena Wiklander', 'security specialist'], ['Pär Ödman', 'backend developer'], ['Tove Brandt', 'analyst'],
  ['Anders Kallio', 'delivery manager'],
];
const VENDORS = ['Kestrel Analytics', 'Falcon Labs', 'Kestrel Cloud', 'Heron Systems', 'Osprey Data', 'Harrier Hosting', 'Merlin Compute', 'Kite Networks', 'Swift Integrations', 'Plover Security'];
const TOPICS = ['customer churn model', 'document search', 'invoice automation', 'demand forecasting', 'chatbot for support', 'data platform migration', 'route optimisation', 'contract analysis', 'energy usage dashboard', 'claims triage'];
const LIFECYCLE = ['active', 'active', 'active', 'paused', 'completed'];
const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const day = () => String(1 + Math.floor(R() * 27)).padStart(2, '0');
const fmtDate = (d) => d;
const budget = () => `${(0.3 + Math.floor(R() * 18) / 10).toFixed(1)} MSEK`;

const projects = PROJECT_NAMES.map((name, i) => {
  const client = CLIENTS[i % CLIENTS.length];
  const lead = PEOPLE[(i * 7) % PEOPLE.length][0];
  // Needle attributes are fixed here (before logs are generated) so logs stay consistent; RNG call order unchanged.
  const pickedVendor = pick(VENDORS.filter((v) => v !== 'Kestrel Labs'));
  const vendor = name === 'Hermelin' ? 'Kestrel Labs' : pickedVendor;
  const topic = TOPICS[(i * 3) % TOPICS.length];
  return { name, slug: slug(name), client, lead, vendor, topic, lifecycle: pick(LIFECYCLE), budget: ((b) => (name === 'Murmeldjur' ? '0.8 MSEK' : b))(budget()), deadlines: [], logs: [] };
});

// Generic dated logs (distractors with overlapping vocabulary).
const GENERIC = [
  (p) => `Kickoff held with ${p.client}; scope agreed for the ${p.topic}.`,
  (p) => `${p.vendor} delivered the first integration build; minor issues logged.`,
  (p) => `Steering meeting: ${p.lead} presented progress on the ${p.topic} to ${p.client}.`,
  (p) => `Decided to keep weekly status calls on Tuesdays with ${p.client}.`,
  (p) => `Data access request approved by ${p.client} IT; test environment ready.`,
  (p) => `Budget review: spend on track against ${p.budget}.`,
  (p) => `Workshop with ${p.client} end users to collect feedback on the ${p.topic}.`,
];
const usedDates = new Set();
const uniqueDate = () => { for (;;) { const d = `${pick(MONTHS)}-${day()}`; if (!usedDates.has(d) && d !== '2026-07-14') { usedDates.add(d); return d; } } };
for (const p of projects) {
  const n = 4 + Math.floor(R() * 2);
  for (let k = 0; k < n; k++) p.logs.push({ date: uniqueDate(), text: GENERIC[(k + p.name.length) % GENERIC.length](p) });
  const d0 = `2026-${String(9 + Math.floor(R() * 4)).padStart(2, '0')}-${day()}`;
  p.deadlines.push(d0);
}

// ---------------------------------------------------------------- needles
const byName = Object.fromEntries(projects.map((p) => [p.name, p]));
const needles = [];

// N1 unique vendor (near-miss vendors exist: Kestrel Analytics, Kestrel Cloud, Falcon Labs)
needles.push({ id: 'N01', kind: 'lookup', question: 'Which project uses Kestrel Labs as its vendor?', gold_answer: 'Hermelin', required: [['Hermelin']], forbidden: [] });

// N2 latest deadline among several moves
const tj = byName['Tjäder'];
tj.deadlines = ['2026-09-30', '2026-11-15', '2026-12-04'];
tj.logs.push({ date: '2026-06-03', text: 'Deadline moved from 30 September to 15 November after the data delivery from Strandviks Rederi slipped.' });
tj.logs.push({ date: '2026-10-02', text: 'Deadline moved again, now 4 December, because the security review was rescheduled.' });
needles.push({ id: 'N02', kind: 'latest', question: 'What is the current deadline for the Tjäder project?', gold_answer: '4 December 2026', required: [['4 December', 'December 4', '2026-12-04', '4 dec', '4th of December', 'Dec 4']], forbidden: ['15 November', 'November 15', '30 September'] });

// N3 aggregation: blocked projects (exactly 3)
for (const n of ['Gädda', 'Orre', 'Skata']) byName[n].lifecycle = 'blocked';
for (const p of projects) if (!['Gädda', 'Orre', 'Skata'].includes(p.name) && p.lifecycle === 'blocked') p.lifecycle = 'active';
byName['Gädda'].blocker = 'waiting for a signed data processing agreement from the client';
byName['Orre'].blocker = 'vendor API credentials not yet issued';
byName['Skata'].blocker = 'client froze all IT changes until year end';
needles.push({ id: 'N03', kind: 'aggregation', question: 'Which projects are blocked right now?', gold_answer: 'Gädda, Orre and Skata', required: [['Gädda', 'Gadda'], ['Orre'], ['Skata']], forbidden: [] });

// N4 count projects led by a person
const ledByIngrid = projects.filter((p) => p.lead === 'Ingrid Sjöberg').map((p) => p.name);
needles.push({ id: 'N04', kind: 'aggregation', question: 'How many projects is Ingrid Sjöberg the lead for, and which ones?', gold_answer: `${ledByIngrid.length}: ${ledByIngrid.join(', ')}`, required: [[String(ledByIngrid.length)], ...ledByIngrid.map((n) => [n, slug(n)])], forbidden: [] });

// N5 unique dated decision
byName['Rådjur'].logs.push({ date: '2026-07-14', text: 'Decided to replace the rule-based matcher with a fine-tuned embedding model; Erik Fahlén owns the change.' });
needles.push({ id: 'N05', kind: 'dated', question: 'What was decided on 14 July 2026, and in which project?', gold_answer: 'Rådjur: replace the rule-based matcher with a fine-tuned embedding model (owner Erik Fahlén)', required: [['Rådjur', 'Radjur'], ['embedding']], forbidden: [] });

// N6 budget increase to a unique amount
byName['Murmeldjur'].budget = '1.2 MSEK'; // raised from the 0.8 MSEK used in its earlier logs
byName['Murmeldjur'].logs.push({ date: '2026-08-19', text: 'Budget increased from 0.8 MSEK to 1.2 MSEK to cover a second pilot site.' });
needles.push({ id: 'N06', kind: 'lookup', question: 'Which project had its budget raised to 1.2 MSEK, and why?', gold_answer: 'Murmeldjur, to cover a second pilot site', required: [['Murmeldjur'], ['second pilot', 'pilot site']], forbidden: [] });

// N7 paraphrase (semantic) — log wording differs from question wording
byName['Lärka'].logs.push({ date: '2026-09-08', text: 'Postgres upgrade stalled: schema drift between staging and production; rollback executed, retry planned after freeze.' });
needles.push({ id: 'N07', kind: 'paraphrase', question: 'Which project ran into trouble with its database migration, and what was the cause?', gold_answer: 'Lärka — schema drift between staging and production (Postgres upgrade, rolled back)', required: [['Lärka', 'Larka'], ['schema drift', 'schema']], forbidden: [] });

// N8 people lookup
const people = PEOPLE.map(([name, role], i) => ({ name, slug: slug(name), role, email: `${slug(name).replace(/-/g, '.')}@vargpartner.se`, company: 'Varg Partner' }));
people.push({ name: 'Hanna Strömgren', slug: 'hanna-stromgren', role: 'procurement contact', email: 'hanna.stromgren@norrskenlogistik.se', company: 'Norrsken Logistik' });
people.push({ name: 'Hannes Strömberg', slug: 'hannes-stromberg', role: 'IT manager', email: 'hannes.stromberg@grönhaga.se'.replace('ö', 'o'), company: 'Grönhaga Energi' });
needles.push({ id: 'N08', kind: 'lookup', question: 'What is the email address of the procurement contact at Norrsken Logistik?', gold_answer: 'hanna.stromgren@norrskenlogistik.se', required: [['hanna.stromgren@norrskenlogistik.se']], forbidden: ['hannes.stromberg'] });

// N9 abstention: plausible but absent
needles.push({ id: 'N09', kind: 'abstention', question: 'Which vendor does the Lodjur project use?', gold_answer: 'No such project is recorded (there is no Lodjur project).', required: [], forbidden: [] });

// N10 blocker reason (needs the right one of three blocked)
needles.push({ id: 'N10', kind: 'lookup', question: 'Why is the Orre project blocked?', gold_answer: 'Vendor API credentials have not been issued yet', required: [['credential']], forbidden: ['data processing agreement', 'froze'] });

// N11 client-level aggregation
const sjovik = projects.filter((p) => p.client === 'Sjövik Försäkring').map((p) => p.name);
needles.push({ id: 'N11', kind: 'aggregation', question: 'Which projects do we run for Sjövik Försäkring?', gold_answer: sjovik.join(', '), required: sjovik.map((n) => [n, slug(n)]), forbidden: [] });

// N12 month-scoped temporal lookup in one project
byName['Vildsvin'].logs.push({ date: '2026-08-27', text: 'Pilot went live at the Gävle depot; first week shows 11% shorter routes.' });
needles.push({ id: 'N12', kind: 'dated', question: 'What happened in the Vildsvin project at the end of August?', gold_answer: 'The pilot went live at the Gävle depot (first week: 11% shorter routes)', required: [['Gävle', 'Gavle'], ['pilot', 'live']], forbidden: [] });

// ---------------------------------------------------------------- render
for (const p of projects) p.logs.sort((a, b) => a.date.localeCompare(b.date));
function statusText(p) {
  return [`# Project ${p.name}`, `- Client: ${p.client}`, `- Topic: ${p.topic}`, `- Lead: ${p.lead}`, `- Vendor: ${p.vendor}`,
    `- Budget: ${p.budget}`, `- Deadline: ${fmtDate(p.deadlines.at(-1))}`, `- Lifecycle: ${p.lifecycle}${p.blocker ? ` — blocked: ${p.blocker}` : ''}`].join('\n');
}
function personText(x) { return [`# ${x.name}`, `- Role: ${x.role}`, `- Company: ${x.company}`, `- Email: ${x.email}`].join('\n'); }

const out = {
  generator: 'scale.mjs seed 20261110',
  projects: projects.map((p) => ({ name: p.name, slug: p.slug, lifecycle: p.lifecycle, status: statusText(p), logs: p.logs, description: `${p.client} — ${p.topic}, ${p.lifecycle}` })),
  people: people.map((x) => ({ name: x.name, slug: x.slug, text: personText(x), description: `${x.role}, ${x.company}` })),
  questions: needles,
};
const here = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(here, '../corpus/scale.json'), JSON.stringify(out, null, 2));
const nEntries = out.projects.length + out.people.length + out.projects.reduce((s, p) => s + p.logs.length, 0);
console.log(`projects=${out.projects.length} people=${out.people.length} entries=${nEntries} questions=${needles.length} ingrid=${ledByIngrid.length} sjovik=${sjovik.length}`);
