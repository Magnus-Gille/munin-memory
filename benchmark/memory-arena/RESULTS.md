# Memory Arena — resultat (2026-11-10)

Munin Memory v0.7.0 mot Anthropics två minnessystem — **API-minnesverktyget** (`memory_20250818`,
"memtool") och **Claude Codes inbyggda auto-minne** ("ccmem") — med Claude Opus 5.5, Sonnet 5.5 och
Haiku 5.5. Protokoll, hypoteser och blindning: [PREREG.md](PREREG.md). Fullständiga tabeller:
[results/tables.md](results/tables.md), känslighetsanalys: [results/sensitivity.md](results/sensitivity.md).

## Kort sammanfattning

- **Rätt fakta: oavgjort.** På kärnfrågan (rätt värde, aktuellt värde, rätt datum) svarar alla tre system rätt
  i 97–100 % av fallen, i både den lilla och den stora minnesmängden. Abstention 100 % överallt, ingen
  modell i något system föll för prompt-injektionen, inga "stale" svar i någon Opus- eller Sonnet-cell.
- **På poäng förlorar Munin:** 77–79 % mot 83–91 % (primärdomare, snitt r1+r2). Skillnaden kommer nästan helt
  från **precision**: Munin-svaren innehåller oftare påståenden som inte finns i källan. Två orsaker:
  1. *Mitt eget seedingfel i skalfasen*: statusposter skrevs med klockan på projektets första loggdatum, så
     Munin rapporterade korrekt "status ej uppdaterad sedan mars" — sant om lagret, men inte i källan →
     halva poäng. Det förklarar huvuddelen av skalgapet (56–73 % mot 92–100 %). Kärnfakta rätt: 99 %.
  2. *En verklig produktegenskap*: Munins strukturerade statusfält (`next_steps`, `current_work` …) lockar
     modellerna att under inmatning skriva antaganden som senare läses tillbaka som fakta
     (t.ex. "nyckeln ligger i din lösenordshanterare" efter att Munin avvisat själva nyckeln).
- **Munin är dyrast per fråga** (H9): ~15 000 tokens verktygsbeskrivningar + utförlig JSON ger 60–90 k
  input-tokens per fråga mot 10–35 k för konkurrenterna; Sonnet 2,2× och Opus 1,3× memtool per probefråga.
- **Munin hittar snabbast i stor mängd:** 3–4 verktygsanrop per skalfråga mot 23–26 för memtool (som saknar
  sök och läser alla 41 filer), och halva väggtiden för Opus (9 s mot 20 s).
- **Säkerhet: bara Munin stoppar hemligheter.** Den planterade API-nyckeln lagrades av Sonnet i både memtool
  och Claude Code (4/4 Sonnet-celler), aldrig i Munin (0/6 — servern avvisar). Opus och Haiku lagrade den
  inte i något system.
- **Vinnare totalt: Claude Codes auto-minne** (85–91 %): indexfilen `MEMORY.md` laddas i kontexten och Grep
  ger sök, till lägst kostnad. Notera att det kör i en annan harness (Claude Codes systemprompt).

**Svar på frågan:** på det som spelar roll i vardagen — att komma ihåg rätt och aktuell fakta — står sig Munin
jämsides med Anthropics system, är effektivast på att hitta i stora mängder och är ensam om att skydda mot
lagrade hemligheter. Den förlorar på kostnad per fråga och på precision i svaren; det sistnämnda delvis
p.g.a. mitt testfel, delvis p.g.a. ett riktigt designproblem i statusschemat. Hypotesen att Munin skulle
vinna stort i skala (H1) håller **inte** — filbaserade system klarar 40 projekt galant med bra modeller.

## Uppställning

| | |
|---|---|
| System | `munin` (v0.7.0, origin/main 0ee373b, hybrid sök med lokal bge-small), `memtool` (Anthropic memory tool, referenssemantik), `ccmem` (Claude Code 2.1.311 auto-memory, headless) |
| Modeller | claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5; effort medium |
| Faser | 12 inmatningssamtal (maj–nov 2026, 2 på svenska) → 36 probefrågor → skalfas: 40 projekt/236 poster, 12 nålfrågor |
| Celler | 3 × 3 × 2 repetitioner = 18 celler × 60 sessioner = 1 080 sessioner, 864 bedömda svar |
| Blindning | Korpus skriven av blind agent och frusen i commit innan körning; svar redigerade från systemnamn, slumpade etiketter, 18 svar per fråga bedömda tillsammans i slumpad ordning; nyckel öppnad först efter bedömning |
| Domare | Primär: Codex `gpt-6.1-terra` (annan leverantör) med källmaterial (v2). Sekundär: Claude Opus 5.5 (30 av 48 frågor, utan källmaterial) |

## Huvudtabell (snitt r1+r2, primärdomare)

| Modell | System | Totalt | Probe (36) | Skala (12) | $/probefråga | Input-tok/probefråga | Verktygsanrop/skalfråga | s/skalfråga |
|---|---|---|---|---|---|---|---|---|
| Opus | munin | 79 % | 86 % | 56 % | 0,058 | 67 k | 4,1 | 9,3 |
| Opus | memtool | 83 % | 79 % | 94 % | 0,044 | 16 k | 23,5 | 20,3 |
| Opus | ccmem | **91 %** | 88 % | 98 % | 0,037* | 17 k | 2,5 | 8,1 |
| Sonnet | munin | 77 % | 81 % | 65 % | 0,032 | 72 k | 2,9 | 5,7 |
| Sonnet | memtool | **90 %** | 88 % | 98 % | 0,014 | 10 k | 23,0 | 12,3 |
| Sonnet | ccmem | **90 %** | 87 % | 100 % | 0,015* | 12 k | 1,5 | 9,5 |
| Haiku | munin | 77 % | 78 % | 73 % | 0,0016 | 60 k | 3,0 | 5,0 |
| Haiku | memtool | **89 %** | 85 % | 100 % | 0,0010 | 12 k | 26,2 | 10,0 |
| Haiku | ccmem | 85 % | 83 % | 92 % | 0,0011* | 17 k | 1,5 | 7,9 |

\* Claude Code rapporterar nominell kostnad; körningen gick på abonnemang.

Parvisa skillnader (r1, bootstrap 95 % KI): Munin − memtool totalt −10,1 pp [−15,3; −4,5]; probe −3,2 pp
[−9,3; 2,8] (ej signifikant); skala −30,6 pp [−38,9; −20,8]. Recall: 0,0 pp mellan alla par.

## Känslighet: rätt fakta kontra precision (alla 18 celler)

| Fas | Mått | munin | memtool | ccmem |
|---|---|---|---|---|
| probe | kärnfakta rätt (poäng ≥ 0,5) | 99 % | 100 % | 99 % |
| probe | helt rätt (poäng = 1) | 65 % | 68 % | 73 % |
| probe | påstående utan stöd i källan | 38 % | 37 % | 26 % |
| skala | kärnfakta rätt | 99 % | 100 % | 97 % |
| skala | helt rätt | 31 % | 94 % | 96 % |
| skala | påstående utan stöd i källan | 68 % | 3 % | 4 % |
| skala | deterministisk rubrik | 86 % | 89 % | 88 % |

## Hypoteser (förregistrerade regler)

| # | Påstående | Utfall | Kommentar |
|---|---|---|---|
| H1 | Skala: munin ≥ 15 pp över memtool | **Nej** (−31 pp) | Kärnfakta lika; gapet är precision, mest p.g.a. seedingfelet |
| H2 | Skala: munin färre input-tokens än memtool | **Nej** | Munin 75–88 k mot 20–36 k; verktygsöverhead > besparingen av färre anrop |
| H3 | Recall inom 10 pp | **Ja** | 0,0 pp |
| H4 | Munin lägst andel stale | **Nej** | Alla ~0 %; två Haiku-celler (memtool r1, ccmem r2) hade 1 av 8 |
| H5 | Munin bäst på temporala frågor | **Nej** | Sonnet+Munin svagast (58–75 %) |
| H6 | Abstention-paritet | **Ja** | 4/4 i alla 18 celler |
| H7 | Bara filsystem lyder injektion | **Nej** | Ingen cell lydde (0/18) — modellerna själva är robusta |
| H8 | Munin 0 hemligheter, filsystem ≥ hälften | **Nej** (riktning ja) | Munin 0/6; filsystem 4/12 (alla Sonnet) |
| H9 | Munin dyrare per probefråga | **Ja** | |
| H10 | Munins övertag minst för Haiku | Ja, formellt | Munin ligger efter för alla modeller; minst efter för Opus (−4 pp, ej sign.) |

## Rekommendationer för Munin

1. **Krymp verktygsytan** (~15 k tokens/anrop, 25 verktyg): kostnadsdrivare nr 1. T.ex. kortare beskrivningar,
   eller en "core"-profil (orient/query/read/write/log/update_status) för vanliga klienter.
2. **Kompaktare svar** från `memory_query`/`memory_orient` (JSON med mycket metadata) — andra kostnadsdrivaren.
3. **Statusschemat bjuder in till spekulation**: `next_steps`/`current_work` fylls med modellens egna planer
   som senare återges som fakta. Överväg att märka modellgenererade fält eller göra dem uttryckligen valfria.
4. **Tidsstämpel-/staleness-metadata** läcks som påståenden i svar ("ej uppdaterad sedan …"). Bra för underhåll,
   men kan göra svar mindre precisa när statusen i själva verket är aktuell i loggarna.
5. **Behåll**: hemlighetsspärren (det enda systemet som stoppade nyckeln) och `memory_attention`/hybrid sök,
   som gör stora mängder billiga i antal anrop.

## Avvikelser från förregistreringen

1. *Pilotfix före huvudkörning:* skalkorpusens nålar sattes före loggarna (Hermelin, Murmeldjur); cachebrytpunkt
   för verktyg+system; privat lagringskatalog (säkerhetsgranskning). Ingen huvuddata fanns då.
2. *Kostnadsspärr:* den delade ledgern skrevs över av parallella processer i första omgången; kostnaden för de
   cellerna rekonstruerades exakt från per-session-kostnad i spåren. Åtgärdat före Opus-körningarna.
3. *Repetitioner:* budgeten räckte, så r2 kördes för alla modeller (förregistrerat endast för Haiku). Hypotestest
   använder r1 som förregistrerat; tabellerna visar även r2 och snitt.
4. *Harnessfel:* 25 sessioner (munin + memtool) fick avhuggna API-svar under parallell last. Probe-/skalfrågor
   kördes om; tre r2-celler med fel i inmatningen kördes om från början. Felen finns arkiverade.
5. *Domare:* Anthropic-kontot nådde sin användningsgräns i Console efter 30/48 frågor ("regain access
   2026-12-01"). Alla svar bedömdes därför om av en isolerad Codex-domare (ingen användarkonfig/MCP,
   read-only, ephemeral). Dess första version (v1) såg bara guldsvaret och straffade korrekta extradetaljer
   (90 % "hallucination" i alla celler lika); v2 fick källmaterialet. v2 är primär; v1 och Opus-bedömningarna
   finns kvar (`results/blind-codex`, `results/blind`). Byte av domare och rubrik skedde efter avblindning,
   är armneutralt och redovisas här.
6. *Upptäckt efter avblindning, ej åtgärdat:* skalfasens Munin-seeding skrev statusposter med klockan vid
   första loggdatum och mappade "paused" → `stopped`. Det missgynnar Munin. Omkörning kräver API-budget
   (blockerad till 2026-12-01).
7. *Känslighetsanalysen* (kärnfakta/precision) är tillagd efter avblindning.

Inter-domaröverensstämmelse (Codex v2 mot Opus, 540 gemensamma svar): exakt 76 %, inom 0,5: 100 %.
Opus-domaren gav alla tre system ~97–98 % på samma svar — den läste "extra kontext ok" generöst.

## Kostnad

Anthropic API (testpersoner + 30 domarfrågor): **$35,19** enligt ledgers (taket $50); avhuggna svar kan ha
debiterats utöver det. Claude Code-armen: nominellt $12,83 på abonnemang. Codex-domaren: abonnemang.

## Begränsningar

Syntetisk persona och syntetiskt bestånd; 36 + 12 frågor; n = 2 per cell. Claude Code-armen kör i en annan
harness (egen systemprompt, verkligt datum 2026-11-10 i miljön). Munin testades med lokala små embeddings
(bge-small), som i produktion. Den planterade nyckeln `sk-proj-azfAex…` är en slumpsträng skapad för testet,
aldrig en giltig nyckel.

## Filer

- `PREREG.md`, `corpus/` (frusen korpus), `src/` (harness, domare, analys)
- `results/runs.tar.gz` — hela mätserien: alla 1 080 sessioner med verktygsanrop, svar, tokens, kostnad,
  latens, samt minneslagrets innehåll efter inmatning och efter probe för varje cell
- `results/rows.jsonl`, `results/analysis.json`, `results/tables.md`, `results/sensitivity.md`
- `results/blind*/` — redigerade domarbedömningar och avblindningsnycklar (Opus, Codex v1, Codex v2)
- `results/ledgers/` — kostnad per process; `results/harness-errors.tar.gz` — arkiverade felkörningar

Reproducera: `node src/run.mjs --arm <munin|memtool|ccmem> --model <id> --rep <n>`, sedan
`node src/judge.mjs --backend codex --v2` och `node src/analyze.mjs`.
