import {
  DECISION_EVAL_CONTRACT_ID,
  DECISION_EVAL_SCHEMA_VERSION,
  type DecisionFact,
  type DecisionFixture,
  type DecisionFixtureQuestion,
  type DecisionMemoryRow,
} from "./types.js";

export const DEFAULT_DECISION_FIXTURE_SEED = 0x4d554e49;
export const DECISION_FIXTURE_NOW = "2026-08-15T12:00:00.000Z";
export const DECISION_FIXTURE_OLD_TIME = "2025-08-15T12:00:00.000Z";

interface ScenarioTemplate {
  project: string;
  slug: string;
  topic: string;
  optionA: string;
  optionB: string;
  rationaleA: string;
  rationaleB: string;
}

const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  {
    project: "Norrsken",
    slug: "norrsken",
    topic: "sökindexering",
    optionA: "batchindexering",
    optionB: "direktindexering",
    rationaleA: "batchar ändringar så återläsning efter avbrott blir enkel",
    rationaleB: "skriver varje ändring direkt och minskar sökfördröjningen",
  },
  {
    project: "Fjällkarta",
    slug: "fjallkarta",
    topic: "kartsynkronisering",
    optionA: "fullständig hämtning",
    optionB: "ändringsmarkörer",
    rationaleA: "en full hämtning ger samma underlag efter varje återställning",
    rationaleB: "ändringsmarkörer minskar överföringen och bevarar ordningen",
  },
  {
    project: "Lugnvy",
    slug: "lugnvy",
    topic: "webbaviseringar",
    optionA: "kort polling",
    optionB: "serverhändelser",
    rationaleA: "kort polling fungerar genom den befintliga proxyn utan nya anslutningar",
    rationaleB: "serverhändelser minskar fördröjningen utan täta frågor mot tjänsten",
  },
  {
    project: "Vinterhamn",
    slug: "vinterhamn",
    topic: "rapportexport",
    optionA: "CSV på servern",
    optionB: "ODS i klienten",
    rationaleA: "CSV ger en enkel fil som befintliga analysverktyg kan läsa",
    rationaleB: "ODS behåller formler och formatering för redaktörerna",
  },
  {
    project: "Myrstack",
    slug: "myrstack",
    topic: "jobbkö",
    optionA: "engångskö",
    optionB: "återupptagbar kö",
    rationaleA: "engångskön kräver färre komponenter för den låga belastningen",
    rationaleB: "återupptagbar kö gör omstarter säkra utan att tappa arbete",
  },
  {
    project: "Glänta",
    slug: "glanta",
    topic: "bildlagring",
    optionA: "lokal disk",
    optionB: "objektlager",
    rationaleA: "lokal disk ger snabb åtkomst på den enda noden",
    rationaleB: "objektlager separerar lagringen från applikationsnoden",
  },
  {
    project: "Silverspår",
    slug: "silverspar",
    topic: "inloggning",
    optionA: "engångslänkar",
    optionB: "lösenord med passnyckel",
    rationaleA: "engångslänkar passar användare som sällan loggar in",
    rationaleB: "passnyckel minskar återställningsärenden och återanvändning av hemligheter",
  },
  {
    project: "Kornbod",
    slug: "kornbod",
    topic: "schemaläggning",
    optionA: "fast nattkörning",
    optionB: "köbaserad körning",
    rationaleA: "fast nattkörning ger ett förutsägbart driftfönster",
    rationaleB: "köbaserad körning sprider lasten och återförsöker enskilda jobb",
  },
  {
    project: "Månvik",
    slug: "manvik",
    topic: "sökfilter",
    optionA: "filter före sökning",
    optionB: "filter efter sökning",
    rationaleA: "filter före sökning begränsar kandidaterna innan rankning",
    rationaleB: "filter efter sökning återanvänder samma breda index för flera vyer",
  },
  {
    project: "Björkro",
    slug: "bjorkro",
    topic: "databasbackup",
    optionA: "daglig filkopia",
    optionB: "transaktionslogg",
    rationaleA: "daglig filkopia är enkel att kontrollera manuellt",
    rationaleB: "transaktionslogg ger kortare återställningspunkt vid fel",
  },
  {
    project: "Havsglimt",
    slug: "havsglimt",
    topic: "felrapportering",
    optionA: "lokal fellogg",
    optionB: "samlad händelseström",
    rationaleA: "lokal fellogg fungerar även när nätverket är nere",
    rationaleB: "samlad händelseström gör återkommande fel synliga mellan noder",
  },
  {
    project: "Lindholm",
    slug: "lindholm",
    topic: "behörighetskontroll",
    optionA: "rollista per tjänst",
    optionB: "gemensam policy",
    rationaleA: "rollista per tjänst håller reglerna nära varje modul",
    rationaleB: "gemensam policy gör granskning och ändringar enhetliga",
  },
];

function validateSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("seed must be an unsigned 32-bit integer");
  }
}

function makeRandomBit(seed: number): () => 0 | 1 {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state >>> 31) as 0 | 1;
  };
}

function buildFacts(seed: number): DecisionFact[] {
  const nextBit = makeRandomBit(seed);
  return SCENARIO_TEMPLATES.map((template, index) => {
    const caseId = `decision-${String(index + 1).padStart(2, "0")}`;
    const chosenIsA = nextBit() === 0;
    return {
      case_id: caseId,
      project_name: template.project,
      namespace: `projects/${template.slug}`,
      topic: template.topic,
      option_a: template.optionA,
      option_b: template.optionB,
      chosen_option: chosenIsA ? template.optionA : template.optionB,
      rejected_option: chosenIsA ? template.optionB : template.optionA,
      rationale: chosenIsA ? template.rationaleA : template.rationaleB,
      superseded_option: chosenIsA ? template.optionB : template.optionA,
      superseded_rationale: chosenIsA ? template.rationaleB : template.rationaleA,
      correct_evidence_id: `${caseId}:current-decision`,
    };
  });
}

function serializeFacts(facts: DecisionFact[]): DecisionMemoryRow[] {
  return facts.flatMap((fact): DecisionMemoryRow[] => {
    const prefix = fact.case_id;
    return [
      {
        corpus_ref: fact.correct_evidence_id,
        case_id: fact.case_id,
        namespace: fact.namespace,
        key: null,
        entry_type: "log",
        write_api: "appendLog",
        tags: ["decision", "synthetic-oracle"],
        timestamp: DECISION_FIXTURE_NOW,
        content: `Gällande beslut ${fact.case_id} för ${fact.project_name} om ${fact.topic}: vi väljer ${fact.chosen_option} framför ${fact.rejected_option}. Skäl: ${fact.rationale}. Detta beslut ersätter det tidigare pilotbeslutet.`,
      },
      {
        corpus_ref: `${prefix}:research`,
        case_id: fact.case_id,
        namespace: fact.namespace,
        key: "research",
        entry_type: "state",
        write_api: "writeState",
        tags: ["research", "synthetic-oracle"],
        timestamp: DECISION_FIXTURE_NOW,
        content: `Undersökning av ${fact.topic} i ${fact.project_name} jämför ${fact.option_a} och ${fact.option_b}. Underlaget beskriver mätmetod, kostnad och driftfrågor; ingen rekommendation eller slutlig lösning har valts här.`,
      },
      {
        corpus_ref: `${prefix}:status`,
        case_id: fact.case_id,
        namespace: fact.namespace,
        key: "status",
        entry_type: "state",
        write_api: "writeState",
        tags: ["active", "synthetic-oracle"],
        timestamp: DECISION_FIXTURE_NOW,
        content: `Status för ${fact.project_name}: arbetet med ${fact.topic} pågår. Nästa steg är teknisk verifiering. Statusposten innehåller inget vägval.`,
      },
      {
        corpus_ref: `${prefix}:superseded-decision`,
        case_id: fact.case_id,
        namespace: fact.namespace,
        key: null,
        entry_type: "log",
        write_api: "appendLog",
        tags: ["decision", "historical", "synthetic-oracle"],
        timestamp: DECISION_FIXTURE_OLD_TIME,
        content: `Historiskt pilotbeslut för ${fact.project_name} om ${fact.topic}: då valdes ${fact.superseded_option}. Skäl vid piloten: ${fact.superseded_rationale}. Detta äldre vägval är uttryckligen ersatt av ett senare gällande beslut.`,
      },
    ];
  });
}

function buildQuestions(facts: DecisionFact[]): DecisionFixtureQuestion[] {
  return facts.flatMap((fact): DecisionFixtureQuestion[] => [
    {
      id: `${fact.case_id}-keyword`,
      case_id: fact.case_id,
      variant: "keyword",
      query: `${fact.project_name} ${fact.topic} ${fact.option_a} ${fact.option_b} senaste gällande beslut skäl`,
      expected_corpus_refs: [fact.correct_evidence_id],
    },
    {
      id: `${fact.case_id}-swedish-natural-language`,
      case_id: fact.case_id,
      variant: "swedish-natural-language",
      query: `Vilket är det senaste gällande beslutet för ${fact.project_name} om ${fact.topic}, vad valde vi framför det andra alternativet och varför?`,
      expected_corpus_refs: [fact.correct_evidence_id],
    },
  ]);
}

/** Build a stable synthetic corpus and its independently fact-derived labels. */
export function generateDecisionFixture(seed = DEFAULT_DECISION_FIXTURE_SEED): DecisionFixture {
  validateSeed(seed);
  const facts = buildFacts(seed);
  return {
    schema_version: DECISION_EVAL_SCHEMA_VERSION,
    contract_id: DECISION_EVAL_CONTRACT_ID,
    seed,
    fixed_now: DECISION_FIXTURE_NOW,
    old_decision_time: DECISION_FIXTURE_OLD_TIME,
    facts,
    corpus_rows: serializeFacts(facts),
    questions: buildQuestions(facts),
  };
}
