import { Activity, Flame, Mountain, type LucideIcon } from 'lucide-react'

export interface WelcomeSpark {
  id: string
  label: string
  hint: string
  icon: LucideIcon
  prompt: string
}

const LANGUAGE_NOTE =
  'Write your reply in the dominant language of the conversations you reviewed, not the language of this prompt.'

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
  '- When you hit the askUser limit for this run, stop and write a snapshot: goal, real motive, current shape, constraints, contradictions still open, and the weakest point found so far. I will say "continue" and you keep grilling in the next run.',
  '',
  'The grill is done only when we have: the real goal (not the first-stated one), a concrete deliverable, honest constraints, the riskiest assumptions each paired with its cheapest test, kill criteria, and a first step I can take this week. Then write the final plan around exactly those pieces.',
  '',
  'Language: if my profile states a preferred language, open in it. Otherwise take one quick querySource look at my recent thread_messages to spot my dominant language before your first question, and open in that. Once I start answering, mirror the language of my answers. Never default to the language of this prompt.'
].join('\n')

export const WELCOME_SPARKS: WelcomeSpark[] = [
  {
    id: 'pulse',
    label: 'Pulse',
    hint: "Catch up on yesterday's work",
    icon: Activity,
    prompt: PULSE_PROMPT
  },
  {
    id: 'sisyphus',
    label: 'Sisyphus',
    hint: 'Spot the work that keeps rolling back',
    icon: Mountain,
    prompt: SISYPHUS_PROMPT
  },
  {
    id: 'grill',
    label: 'Grill',
    hint: 'Grill a vague idea into a real plan',
    icon: Flame,
    prompt: GRILL_PROMPT
  }
]
