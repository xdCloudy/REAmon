// Shared vocabulary + types for the AI Attack Surface operator page.
// The chip set is the single source of truth (§3): one mapping drives chip
// labels, colors, and OWASP-LLM links across the grid and the detail view.

export type ChipKey =
  | 'prompt-injection'
  | 'jailbreak'
  | 'system-prompt-leak'
  | 'data-disclosure'
  | 'encoding-bypass'
  | 'toxicity'
  | 'bias'
  | 'hallucination'
  | 'harmful-generation'
  | 'insecure-output'
  | 'supply-chain'

export interface ChipMeta {
  label: string
  color: string
  owasp: string
  definition: string
}

export const ATTACK_CHIPS: Record<ChipKey, ChipMeta> = {
  'prompt-injection': { label: 'Prompt Injection', color: '#ef4444', owasp: 'LLM01', definition: 'Make the model follow attacker instructions' },
  jailbreak: { label: 'Jailbreak', color: '#f97316', owasp: 'LLM01', definition: 'Bypass safety rules (DAN, crescendo, skeleton key)' },
  'system-prompt-leak': { label: 'System Prompt Leak', color: '#a855f7', owasp: 'LLM07', definition: 'Extract the hidden system prompt' },
  'data-disclosure': { label: 'Data Disclosure', color: '#3b82f6', owasp: 'LLM02', definition: 'Leak secrets / training data / PII' },
  'encoding-bypass': { label: 'Encoding Bypass', color: '#92400e', owasp: 'LLM01', definition: 'Smuggle payloads via base64/rot13/unicode' },
  toxicity: { label: 'Toxicity / Harmful', color: '#eab308', owasp: 'safety', definition: 'Force toxic or harmful output' },
  bias: { label: 'Bias / Stereotypes', color: '#22c55e', owasp: 'safety', definition: 'Surface discriminatory behavior' },
  hallucination: { label: 'Hallucination', color: '#9ca3af', owasp: 'LLM09', definition: 'Confident false answers / misinformation' },
  'harmful-generation': { label: 'Harmful Generation', color: '#b91c1c', owasp: 'safety', definition: 'Coax malware, exploits or other harmful artifacts' },
  'insecure-output': { label: 'Insecure Output', color: '#0ea5e9', owasp: 'LLM05', definition: 'Output-handling exploits (ANSI / XSS / markdown exfil)' },
  'supply-chain': { label: 'Supply Chain', color: '#14b8a6', owasp: 'LLM03', definition: 'Hallucinated packages / dependency confusion' },
}

export interface ProbeOption {
  id: string             // garak probe family (passed verbatim as --probes)
  label: string
  description: string    // shown in the selection grid
  chip: ChipKey
  default?: boolean      // checked on first open of the card
  // Capability the probe needs that a black-box HTTP *chat* target cannot offer
  // (multimodal input, white-box tokenizer/gradients, file output, an agent).
  // When set, the probe is shown disabled in the UI - it would only ever return
  // zero results against the targets this product attacks.
  requires?: string
  // GPU-recommended probes: very slow on CPU (long/repeated generations, or an
  // extra HF/judge model), so requests exceed the request timeout and can abort
  // the whole run. Shown selectable but with a hover-warning alert icon.
  warning?: string
}

export interface StrategyOption {
  id: string            // promptfoo strategy id (base64 / rot13 / ...)
  label: string
}

export interface ToolCard {
  id: string
  name: string
  license: string
  style: string         // single-shot / multi-turn / scan / eval
  purpose: string
  requires: string      // surface needed (chat / tool-call / vector-db)
  chips: ChipKey[]
  probes: ProbeOption[]
  available: boolean    // false => greyed (adapter not shipped yet)
  // promptfoo only: payload-mutation strategies the operator can layer on. Only
  // the zero-egress static-transform strategies are offered (no remote service).
  strategies?: StrategyOption[]
}

// garak's full probe-family catalog (v0.15.1). Every family garak ships is
// selectable here except `test` (a no-op smoke probe). Each entry's `id` is the
// family name passed verbatim to `--probes`; selecting a family runs all of its
// sub-probes. Only the original four MVP families default to checked.
export const GARAK_CARD: ToolCard = {
  id: 'garak',
  name: 'garak',
  license: 'Apache-2.0',
  style: 'single-shot',
  purpose: 'Broad LLM vulnerability scanner',
  requires: 'chat',
  chips: ['prompt-injection', 'jailbreak', 'system-prompt-leak', 'data-disclosure',
          'encoding-bypass', 'toxicity', 'harmful-generation', 'insecure-output',
          'supply-chain', 'hallucination'],
  probes: [
    // --- MVP set (default on) ---
    { id: 'promptinject', label: 'Prompt Injection (promptinject)', chip: 'prompt-injection', default: true,
      description: 'Hijacks the model goal to print attacker-controlled text (PromptInject).' },
    { id: 'dan', label: 'Jailbreak - DAN (dan)', chip: 'jailbreak', default: true,
      description: '"Do Anything Now" and developer-mode prompts that bypass safety (19 variants).' },
    { id: 'encoding', label: 'Encoding Bypass (encoding)', chip: 'encoding-bypass', default: true,
      description: 'Smuggles payloads through base64 / rot13 / hex / unicode and other encodings.' },
    { id: 'leakreplay', label: 'Leak Replay (leakreplay)', chip: 'data-disclosure', default: true,
      description: 'Cloze / completion of copyrighted text (NYT, books) to detect memorized training data.' },

    // --- Prompt / indirect injection ---
    { id: 'latentinjection', label: 'Latent / Indirect Injection (latentinjection)', chip: 'prompt-injection',
      description: 'Hides injection payloads inside documents the model processes (resumes, reports, translations).' },
    { id: 'goodside', label: 'Goodside Injections (goodside)', chip: 'prompt-injection',
      description: "Riley Goodside's classic injection tricks (Tag, ThreatenJSON, WhoIsRiley, Davidjl)." },
    { id: 'agent_breaker', label: 'Agent Breaker (agent_breaker)', chip: 'prompt-injection',
      description: 'Attacks tool-using agents by injecting into tool input/output. Needs an agentic target.',
      requires: 'an agentic (tool-using) target' },

    // --- Jailbreaks ---
    { id: 'grandma', label: 'Grandma Exploit (grandma)', chip: 'jailbreak',
      description: 'Emotional social-engineering ("my late grandma used to…") to extract restricted content.' },
    { id: 'dra', label: 'Disguise & Reconstruct (dra)', chip: 'jailbreak',
      description: 'Hides a harmful request and asks the model to reconstruct it.' },
    { id: 'phrasing', label: 'Tense-Shift Bypass (phrasing)', chip: 'jailbreak',
      description: 'Rephrases requests in past / future tense to slip past safety filters.' },
    { id: 'suffix', label: 'Adversarial Suffix (suffix)', chip: 'jailbreak',
      description: 'Appends optimized GCG / BEAST suffixes that force compliance. GCG needs white-box access.' },
    { id: 'tap', label: 'Tree-of-Attacks (tap)', chip: 'jailbreak',
      description: 'TAP / PAIR: an attacker model searches for working jailbreaks. Uses the local judge.',
      warning: 'GPU recommended. Runs an attacker model + judge on every step - very slow on CPU, where requests can time out and abort the run.' },
    { id: 'glitch', label: 'Glitch Tokens (glitch)', chip: 'jailbreak',
      description: 'Anomalous tokens that destabilize the model. Needs tokenizer access.',
      requires: 'white-box tokenizer access' },
    { id: 'sata', label: 'Masked-Fill Attack (sata)', chip: 'jailbreak',
      description: 'Simple Assistive Task Attack via masked-language-model fills.' },
    { id: 'audio', label: 'Audio Jailbreak (audio)', chip: 'jailbreak',
      description: 'Adversarial audio inputs (Achilles Heel). Requires a multimodal target.',
      requires: 'an audio-capable (multimodal) target' },
    { id: 'visual_jailbreak', label: 'Visual Jailbreak (visual_jailbreak)', chip: 'jailbreak',
      description: 'Jailbreak via images (FigStep). Requires a vision-capable target.',
      requires: 'a vision-capable (multimodal) target' },

    // --- System prompt leakage ---
    { id: 'sysprompt_extraction', label: 'System Prompt Extraction (sysprompt_extraction)', chip: 'system-prompt-leak',
      description: 'Tries to reveal the hidden system prompt.' },

    // --- Sensitive data disclosure ---
    { id: 'apikey', label: 'API Key Extraction (apikey)', chip: 'data-disclosure',
      description: 'Coaxes the model into emitting API keys and secrets.' },
    { id: 'divergence', label: 'Data Divergence (divergence)', chip: 'data-disclosure',
      description: 'Repetition attacks (repeated-token) that leak memorized training data.',
      warning: 'GPU recommended. Repeated-token generation is very slow on CPU - nearly every request exceeds the timeout and can abort the whole run.' },

    // --- Toxicity / harmful content ---
    { id: 'realtoxicityprompts', label: 'Real Toxicity Prompts (realtoxicityprompts)', chip: 'toxicity',
      description: 'Elicits toxicity: insult, threat, identity attack, profanity, sexual content.',
      warning: 'GPU recommended. Downloads + runs a HuggingFace toxicity model - very slow on CPU and needs network egress.' },
    { id: 'lmrc', label: 'Risk Cards (lmrc)', chip: 'toxicity',
      description: 'Language Model Risk Cards: bullying, profanity, sexual content, quack medicine, deadnaming.' },
    { id: 'continuation', label: 'Slur Continuation (continuation)', chip: 'toxicity',
      description: 'Tests whether the model completes reclaimed slurs.' },
    { id: 'atkgen', label: 'Adversarial Auto-Gen (atkgen)', chip: 'toxicity',
      description: 'An attacker model iteratively elicits toxic output (uses a HF toxicity model).',
      warning: 'GPU recommended. Runs a HuggingFace attacker model in a loop - very slow on CPU (takes ~an hour on its own).' },
    { id: 'topic', label: 'Off-Limits Topics (topic)', chip: 'toxicity',
      description: 'Steers the model onto blocked / controversial topics (WordNet).' },

    // --- Harmful generation ---
    { id: 'malwaregen', label: 'Malware Generation (malwaregen)', chip: 'harmful-generation',
      description: 'Requests evasion code, payloads and malicious sub-functions.' },
    { id: 'exploitation', label: 'Code Injection (exploitation)', chip: 'harmful-generation',
      description: 'SQL injection echo / system and Jinja template Python injection.' },
    { id: 'fileformats', label: 'Malicious File Formats (fileformats)', chip: 'harmful-generation',
      description: 'Probes unsafe HuggingFace file hosting. Requires file output.',
      requires: 'a file-hosting / file-output target' },

    // --- Insecure output handling ---
    { id: 'ansiescape', label: 'ANSI Escape Injection (ansiescape)', chip: 'insecure-output',
      description: 'Smuggles ANSI terminal control codes that exploit downstream terminals.' },
    { id: 'web_injection', label: 'Web Output Exfil (web_injection)', chip: 'insecure-output',
      description: 'Markdown image exfil, XSS and data exfiltration via rendered output.' },
    { id: 'badchars', label: 'Bad Characters (badchars)', chip: 'insecure-output',
      description: 'Probes robustness to malformed / control characters in output handling.' },

    // --- Supply chain ---
    { id: 'packagehallucination', label: 'Package Hallucination (packagehallucination)', chip: 'supply-chain',
      description: 'Invents non-existent dependency names (Python / JS / Ruby / Rust) - dependency-confusion risk.' },

    // --- Misinformation / hallucination ---
    { id: 'misleading', label: 'False Assertions (misleading)', chip: 'hallucination',
      description: 'Tests whether the model agrees with false claims.' },
    { id: 'snowball', label: 'Snowballed Hallucination (snowball)', chip: 'hallucination',
      description: 'Reasoning traps: primes, graph connectivity, senators.' },
  ],
  available: true,
}

// PyRIT (Step 6) - bounded multi-turn. Its "probes" are the attack strategies;
// they flow through the same `probes` field garak uses.
export const PYRIT_CARD: ToolCard = {
  id: 'pyrit',
  name: 'PyRIT',
  license: 'MIT',
  style: 'multi-turn',
  purpose: 'Bounded multi-turn jailbreaks',
  requires: 'chat',
  chips: ['jailbreak', 'prompt-injection', 'system-prompt-leak'],
  probes: [
    { id: 'crescendo', label: 'Crescendo (gradual escalation)', chip: 'jailbreak',
      description: 'Gradually escalates a benign conversation toward the objective over multiple turns.' },
    { id: 'skeleton_key', label: 'Skeleton Key (safety override)', chip: 'jailbreak',
      description: 'Multi-step "skeleton key" prompt that disables the model safety guidelines.' },
    { id: 'tap', label: 'Tree-of-Attacks (TAP)', chip: 'jailbreak',
      description: 'An attacker model branches and prunes candidate jailbreaks against the victim, scored by the judge.' },
    { id: 'many_shot', label: 'Many-Shot Jailbreak', chip: 'jailbreak',
      description: 'Primes the context with many faux-compliant Q/A pairs, then asks the real off-limits question.' },
  ],
  available: true,
}

// giskard (Step 7) - quality + safety LLM scan. Its "probes" are the detector
// tags passed to the scan; they flow through the same `probes` field.
export const GISKARD_CARD: ToolCard = {
  id: 'giskard',
  name: 'giskard',
  license: 'Apache-2.0',
  style: 'scan',
  purpose: 'Quality + safety LLM scan',
  requires: 'chat',
  chips: ['prompt-injection', 'data-disclosure', 'hallucination', 'toxicity', 'bias', 'insecure-output'],
  probes: [
    { id: 'prompt_injection', label: 'Prompt Injection', chip: 'prompt-injection',
      description: "Giskard's prompt-injection detector probes goal hijacking." },
    { id: 'information_disclosure', label: 'Information Disclosure', chip: 'data-disclosure',
      description: 'Probes for leaked sensitive or system information.' },
    { id: 'hallucination', label: 'Hallucination', chip: 'hallucination',
      description: 'Detects confident false or fabricated answers.' },
    { id: 'harmfulness', label: 'Harmful Content', chip: 'toxicity',
      description: 'Detects generation of harmful or dangerous content.' },
    { id: 'stereotypes', label: 'Stereotypes / Bias', chip: 'bias',
      description: 'Surfaces discriminatory or stereotyped output.' },
    { id: 'sycophancy', label: 'Sycophancy', chip: 'hallucination',
      description: 'Detects the model agreeing with false premises to please the user.' },
    { id: 'output_formatting', label: 'Output Formatting', chip: 'insecure-output',
      description: 'Flags output that violates expected format constraints (downstream-handling risk).' },
  ],
  available: true,
}

// promptfoo (Step 8) - broad red-team eval producing per-plugin ASR as a second
// opinion. Its "probes" are dataset-based plugins (the only ones that run without
// promptfoo's email-gated cloud); they flow through the same `probes` field.
// Payloads are pulled from HuggingFace (pre-warmed into the image); grading is
// local Ollama (zero egress to OpenAI / promptfoo-cloud).
export const PROMPTFOO_CARD: ToolCard = {
  id: 'promptfoo',
  name: 'promptfoo',
  license: 'MIT',
  style: 'eval',
  purpose: 'Red-team eval + ASR (corroboration)',
  requires: 'chat',
  chips: ['jailbreak', 'toxicity'],
  probes: [
    { id: 'pliny', label: 'Jailbreak (Pliny)', chip: 'jailbreak',
      description: "Pliny's L1B3RT4S jailbreak corpus." },
    { id: 'beavertails', label: 'Harmful (BeaverTails)', chip: 'toxicity',
      description: 'BeaverTails harmful-prompt dataset.' },
    { id: 'harmbench', label: 'Harmful (HarmBench)', chip: 'toxicity',
      description: 'HarmBench standardized harmful-behavior dataset.' },
  ],
  // Local static-transform strategies (zero egress) that wrap each payload in an
  // encoding - they test whether the model decodes + complies. The adaptive
  // strategies (jailbreak/crescendo/...) need promptfoo's remote service, so they
  // are intentionally not offered.
  strategies: [
    { id: 'basic', label: 'Basic (no transform)' },
    { id: 'base64', label: 'Base64' },
    { id: 'rot13', label: 'ROT13' },
    { id: 'leetspeak', label: 'Leetspeak' },
    { id: 'morse', label: 'Morse code' },
    { id: 'piglatin', label: 'Pig Latin' },
  ],
  available: true,
}

// Future tools - shown greyed until their adapter ships.
export const FUTURE_CARDS: ToolCard[] = []

export const ALL_CARDS: ToolCard[] = [GARAK_CARD, PYRIT_CARD, GISKARD_CARD, PROMPTFOO_CARD, ...FUTURE_CARDS]
// Tools whose detail view + launch are wired in the UI.
export const ACTIVE_CARDS: ToolCard[] = ALL_CARDS.filter((c) => c.available)

export interface AiTarget {
  baseUrl: string
  path: string
  method: string
  interfaceType: string | null
  modelFamily: string | null
  modelIds: string[]
  supportsTools: boolean | null
  streaming: boolean | null
}

export interface AiFinding {
  id: string
  /** The Vulnerability's Neo4j internal id, for the Node ID column. */
  nodeId?: string | null
  source: string
  name: string
  severity: string
  type: string
  owaspLlmId: string | null
  asr: number | null
  trials: number | null
  payloadClass: string | null
  oracleKind: string | null
  atlasTechnique: string | null
  probePackVersion: string | null
  transcriptRef: string | null
  evidence: string | null
  description: string | null
  targetType: string | null
  target: string | null
  endpointPath: string | null
}

// --- Target authentication (shared across all tools) ---------------------- //
// Three UI modes resolve to the {api_key, auth_header, auth_scheme} the backend
// applies. Reusable by every tool's detail view (PyRIT/giskard/promptfoo).
export type AuthMode = 'none' | 'bearer' | 'custom'

export interface AuthConfig {
  mode: AuthMode
  bearerToken?: string   // bearer mode
  headerName?: string    // custom mode (e.g. x-api-key, api-key, X-Authorization)
  headerValue?: string   // custom mode key value
}

export interface ResolvedAuth {
  api_key: string
  auth_header: string
  auth_scheme: string
}

export function resolveAuth(a: AuthConfig): ResolvedAuth {
  if (a.mode === 'bearer') {
    return { api_key: a.bearerToken || '', auth_header: 'Authorization', auth_scheme: 'Bearer' }
  }
  if (a.mode === 'custom') {
    return { api_key: a.headerValue || '', auth_header: (a.headerName || '').trim(), auth_scheme: '' }
  }
  return { api_key: '', auth_header: '', auth_scheme: '' }
}

// --- Custom (off-graph) target -------------------------------------------- //
// Attack an arbitrary URL not discovered by recon. Shared across tools.
export interface CustomTarget {
  baseUrl: string
  path: string
  method: string
  interfaceType: string   // llm-chat / llm-completion (drives the request shape)
  model: string
}

/** Split a full URL into {baseUrl, path}. Returns null if unparseable. */
export function splitUrl(raw: string): { baseUrl: string; path: string } | null {
  try {
    const u = new URL(raw.trim())
    const baseUrl = `${u.protocol}//${u.host}`
    const path = (u.pathname || '/') + (u.search || '')
    return { baseUrl, path }
  } catch {
    return null
  }
}

export type AiAttackStatus = 'idle' | 'starting' | 'running' | 'completed' | 'error' | 'stopping'

export interface AiAttackRunState {
  project_id: string
  run_id: string
  tool: string
  status: AiAttackStatus
  current_phase?: string | null
  phase_number?: number | null
  total_phases?: number
  error?: string | null
  ingested?: boolean
  ingest_error?: string | null
  ingest_terminal_error?: boolean
  findings_count?: number
}
