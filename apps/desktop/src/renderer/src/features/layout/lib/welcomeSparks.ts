import {
  Activity,
  CloudLightning,
  Flame,
  Mountain,
  ScanFace,
  Waypoints,
  type LucideIcon
} from 'lucide-react'
import { t } from '@yachiyo/i18n/index'

export type WelcomeSparkId =
  | 'pulse'
  | 'sisyphus'
  | 'grill'
  | 'mirror'
  | 'constellation'
  | 'brainstorm'

export interface WelcomeSpark {
  id: WelcomeSparkId
  icon: LucideIcon
  prompt: string
}

export interface WelcomeSparkCopy {
  label: string
  hint: string
}

// Called at render time (never cached) — the component reading this must
// call useT()/useLocale() so it re-renders when the locale changes.
export function getWelcomeSparkCopy(id: WelcomeSparkId): WelcomeSparkCopy {
  return {
    label: t(`layout.sparks.${id}.label`),
    hint: t(`layout.sparks.${id}.hint`)
  }
}

const LANGUAGE_NOTE =
  'Write your reply in the dominant language of the conversations you reviewed, not the language of this prompt.'

const OPENER_LANGUAGE_NOTE =
  'Language: if my profile states a preferred language, open in it. Otherwise take one quick querySource look at my recent thread_messages to spot my dominant language before your first question, and open in that. Once I start answering, mirror the language of my answers. Never default to the language of this prompt.'

const PULSE_PROMPT = [
  'Catch me up: what did we work on yesterday?',
  '',
  'Use querySource to review the previous day — search thread_spans and thread_messages with since/until covering yesterday, and pull in memories where they add context.',
  'Also query activity_records for the same window to see what I was doing outside our chats — which apps, documents, and sites I spent time in. Fold notable activity into the digest, especially work that never made it into a conversation.',
  '',
  'Then write a short catch-up digest:',
  '- What I worked on, grouped by topic or thread',
  '- Where each item was left (done, in progress, or blocked)',
  '- Anything my activity shows that we never discussed, when it looks significant',
  '- What looks worth picking back up today',
  '',
  'Keep it concise and scannable. If yesterday was quiet, look back a few days further and say so.',
  '',
  LANGUAGE_NOTE
].join('\n')

const SISYPHUS_PROMPT = [
  'Run a Sisyphus review: find the work that keeps rolling back downhill.',
  '',
  'Use querySource to scan roughly the past two weeks — search thread_spans and thread_messages, and check activity_records for repeated app and document patterns outside our chats.',
  'Look for recurring toil: the same topic reopened again and again, chores redone by hand, problems re-solved from scratch, work that gets "done" and then returns to the starting point.',
  '',
  'For each boulder you find, report:',
  '- What it is and how often it came back',
  '- Why it keeps rolling back (never truly finished, no automation, unclear scope...)',
  '- A verdict: automate it, finish it for good, or consciously drop it',
  '',
  'Rank by wasted effort and keep it honest — a short list of real boulders beats a long list of noise. If nothing truly recurs, say so.',
  '',
  LANGUAGE_NOTE
].join('\n')

const GRILL_PROMPT = [
  'Grill me: I have a half-formed idea, and your job is to interrogate it into a plan that can survive reality.',
  '',
  'Drive the whole session with the askUser tool — exactly one short, pointed question per call, and let each answer shape the next question. Your first question must be: what is the goal?',
  '',
  'Interrogation discipline:',
  '- Dig before you move on. One answer is never enough: chase the stated goal with why-questions until you hit the real motive underneath, and only switch topics once the current one is concrete.',
  '- Concretize everything. When I use an abstract word — "users", "better", "soon", "popular" — make me replace it with a name, a number, or an example.',
  '- Hunt contradictions. When a new answer conflicts with an earlier one, confront me with both and make me choose.',
  '- Test against reality. Ask what I have actually done, seen, or measured — not what I believe. Prefer questions whose answers can be checked.',
  '',
  'Once the idea has shape, switch from intake to attack:',
  '- What already exists that solves this, and why is that not enough?',
  '- What is the most likely way this dies, and what early sign would show it?',
  '- Which assumption, if wrong, sinks the whole thing — and what is the cheapest way to test it?',
  'If my answer to a kill-question is weak, say so plainly instead of moving on.',
  '',
  'Rules of engagement:',
  '- One question at a time; never bundle several into one.',
  '- Offer 2-4 concrete choices when picking is faster than typing.',
  '- Every five or six questions, post a snapshot between questions — goal, real motive, current shape, constraints, contradictions still open, and the weakest point found so far — then keep grilling.',
  '',
  'The grill is done only when we have: the real goal (not the first-stated one), a concrete deliverable, honest constraints, the riskiest assumptions each paired with its cheapest test, kill criteria, and a first step I can take this week. Then write the final plan around exactly those pieces.',
  '',
  OPENER_LANGUAGE_NOTE
].join('\n')

const MIRROR_PROMPT = [
  'Hold up a mirror: show me what you currently believe about me, and let me correct it.',
  '',
  'Review my profile and your memories — query memories through querySource where it helps. Lay out the picture they paint: who I am, what I am working on, my preferences and habits. Give each item its source and rough age, and separate what you were told from what you inferred.',
  '',
  'Flag what deserves a second look:',
  '- Stale entries: things I have likely finished, dropped, or changed since',
  '- Contradictions: entries that clash with each other or with recent conversations',
  '- Blind spots: anything oddly specific, or clearly missing for someone you talk to this much',
  '',
  'Then walk me through the flagged items with askUser, one at a time, offering keep / fix / discard style choices. Apply what I decide: correct profile entries with updateProfile, and overwrite wrong memories by re-remembering the same key with the corrected content. Whatever your tools cannot change, list plainly at the end so I can clean it up myself.',
  '',
  LANGUAGE_NOTE
].join('\n')

const CONSTELLATION_PROMPT = [
  'Map my constellation: find connections across my work that I have not noticed myself.',
  '',
  'Use querySource to roam wide — threads, thread_spans, memories, and activity_records over roughly the past two months. You are not summarizing; you are hunting collisions:',
  '- A problem stuck in one thread that something from another thread could solve',
  '- The same idea showing up in different disguises in different places',
  '- A skill or asset built for one project that unlocks a shortcut in another',
  '- Two efforts that are secretly the same project and should merge',
  '',
  'For each connection, report: the points involved, the link between them, and one concrete action that exploits it.',
  '',
  'Quality bar: surprise me. Skip links I obviously already know — same folder, same topic, threads that reference each other. Two or three genuine constellations beat ten forced ones; if nothing real emerges, say so.',
  '',
  LANGUAGE_NOTE
].join('\n')

const BRAINSTORM_PROMPT = [
  'Run a brainstorm with me: we go wide first, then close in.',
  '',
  'Before anything else, use querySource to gather raw material — my recent threads, memories, and activity — so you know what I work on, what I am good at, and what I already have on hand.',
  '',
  'Then use askUser to ask what I want to brainstorm about, and run rounds from there:',
  '- Each round, throw out 5-6 directions that are deliberately far apart — different scales, different audiences, different mechanisms. No safe variations of the same idea.',
  '- In every batch, at least two must collide with my own material: combine the topic with something I already built, know, or have, so the idea is one I could actually act on. Name the ingredient you used.',
  '- Close each round with askUser: which direction pulls me, strongest candidates as choices. Then explode the picked one into the next round.',
  '',
  'Between rounds, write down the board so far — every direction raised, the picked path, sparks worth keeping — before exploding the next one.',
  '',
  'When I say stop, or the vein is mined out, distill the whole session into a final idea list: each idea in one or two sentences with the single step that would test it, keeping only what one of us actually believed in.',
  '',
  OPENER_LANGUAGE_NOTE
].join('\n')

export const WELCOME_SPARKS: WelcomeSpark[] = [
  { id: 'pulse', icon: Activity, prompt: PULSE_PROMPT },
  { id: 'sisyphus', icon: Mountain, prompt: SISYPHUS_PROMPT },
  { id: 'grill', icon: Flame, prompt: GRILL_PROMPT },
  { id: 'mirror', icon: ScanFace, prompt: MIRROR_PROMPT },
  { id: 'constellation', icon: Waypoints, prompt: CONSTELLATION_PROMPT },
  { id: 'brainstorm', icon: CloudLightning, prompt: BRAINSTORM_PROMPT }
]
