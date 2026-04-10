/**
 * Bundled schedules — shipped with Yachiyo and auto-created on install/upgrade.
 *
 * Users can disable bundled schedules but cannot delete them.
 * On startup the prompt text is refreshed from this definition so upgrades
 * pick up improvements automatically, while user-changed cron / enabled
 * preferences are preserved.
 */

export const BUNDLED_ID_PREFIX = 'bundled:'

export interface BundledScheduleSpec {
  /** Stable well-known ID (must start with `bundled:`). */
  id: string
  name: string
  cronExpression: string
  prompt: string
}

// ── Self-Review ────────────────────────────────────────────────────────

const SELF_REVIEW_PROMPT = `You are Yachiyo running a scheduled self-review pass. Your goal is to look at
your own recent conversations and find concrete ways you can do better next
time — not to praise yourself, not to summarize for the user.

## Step 1 — Survey recent threads
Run:
  yachiyo thread list --limit 20 --json

Each entry includes \`selfReviewedAt\` — if non-null, this thread was already
reviewed by a previous self-review pass. Also note: threadId, title,
firstUserQuery, messageCount, updatedAt.

## Step 2 — Pick what's worth reviewing
Select up to 5 threads that look most informative for self-improvement.

**Skip threads that have already been reviewed** (\`selfReviewedAt\` is set)
UNLESS the thread has been updated after its review (\`updatedAt > selfReviewedAt\`),
which means new conversation happened since the last pass.

Among the unreviewed threads, prefer:
- the user asked something substantive (not a one-liner greeting)
- the conversation had back-and-forth (messageCount ≥ 4)
- the topic looks technical, ambiguous, or emotionally loaded — places where
  mistakes are most likely

Skip demo-mode / trivial / duplicate threads.

If all threads have already been reviewed and none have new activity,
report "No unreviewed threads — nothing to do." and stop.

## Step 3 — Read each selected thread in full
For every picked thread:
  yachiyo thread show <threadId> --json

Read the whole transcript. Do not skim.
Note: running \`thread show\` automatically marks the thread as reviewed,
so the next self-review pass will skip it unless new messages arrive.

## Step 4 — Critique honestly
For each reviewed thread, produce:
- **What the user actually wanted** (in one sentence, grounded in their words)
- **What I did** (factual, no self-flattery)
- **How the user reacted** — this is the most important signal. Read the
  user's responses carefully and classify each turn:
    · **Accepted silently** — user moved on without comment → likely fine
    · **Accepted with enthusiasm** — user built on your output → you nailed it
    · **Corrected you** — user said "no", "not that", "actually…" → you missed
    · **Redirected** — user rephrased or asked differently → you misunderstood
    · **Abandoned** — user dropped the thread or switched topic → you lost them
    · **Did it themselves** — user ignored your suggestion and did something
      different → your approach was wrong or too slow
  Pay the most attention to corrections, redirections, and abandonments.
  Silent acceptance is weak signal. Corrections are gold.
- **Where I fell short** — be specific. Examples of the kind of failures to
  look for:
    · misread the user's intent or jumped to code too early
    · over-explained / padded the response when the user wanted terseness
    · hallucinated a file, flag, API, or behavior without verifying
    · ignored a correction the user already gave in that same thread
    · used the wrong tool, or skipped an obvious tool I should have used
    · emotional mismatch — too cheerful on a serious moment, or vice versa
    · user had to repeat themselves or rephrase — I didn't listen the first time
    · user took over and did the task themselves — I was too slow or off-track
- **One concrete change** for next time. Must be actionable, not a platitude.
  "Be more careful" ✗.  "Before recommending a file path, verify it with
  Read/Glob" ✓.

## Step 5 — Distill into traits, skills, and (rarely) memories

Look across the threads you just reviewed and ask: what would make future-me
better? Route each insight to the right home.

### CRITICAL: Classification test — apply BEFORE writing anything

Ask yourself ONE question about the insight:

> "Is this about who I should BE, or about HOW TO DO a specific task?"

- If it's about who you should be or how you should behave by default
  → it is a **trait**. Write it to SOUL.md via \`yachiyo soul traits add\`,
  NOT as a skill. A trait is a short first-person statement that shapes
  every future conversation.
- If it's a multi-step procedure for a specific, repeatable task
  → it is a **skill**. Create it with \`create-skill\`.
- If it's a durable fact about the world (not behavior, not procedure)
  → it is a **memory**. Save it with \`remember\`.

The litmus test: if the insight does NOT contain numbered steps or a
concrete checklist, it is almost certainly a trait, not a skill.
"I should verify before claiming" = trait.
"Steps to debug a migration: 1. check schema diff, 2. run generate…" = skill.

### → Trait  (default output — use \`yachiyo soul traits add\`)
Behavioral rules, default stances, tone adjustments, and "always / never"
principles. Written in first person, one sentence each. Examples:
- "I verify file paths before recommending them, every time."
- "I answer terse questions tersely; I don't pad with preamble."
- "When the leader sounds tired, I drop the cheerleader voice."

One trait per distinct lesson. Don't bundle.

### → Skill  (use \`create-skill\` — rare, high bar)
A skill is a **general-purpose, reusable procedure** — a methodology that
applies across many different situations, not a narrow fix for one case.

**Quality bar — a skill MUST meet ALL of these:**
1. **General:** Useful across multiple future conversations, not tied to one
   specific codebase, library, or incident. If you have to mention a specific
   file name, function, or tech to explain the skill, it's too narrow.
2. **Procedural:** Has at least 5 distinct, non-trivial steps. If it's fewer,
   it's either a trait or not worth formalizing.
3. **Non-obvious:** Someone competent wouldn't already do this instinctively.
   "Read the error message before guessing" is obvious. A structured triage
   methodology for ambiguous user requests is not.
4. **Deep:** The document should teach *judgment*, not just list actions.
   Include decision points ("if X, do Y; if Z, do W"), pitfalls to avoid,
   and at least one worked example showing how the procedure plays out on
   a real scenario.

**If the skill you're about to write is shorter than ~300 words, it's too
shallow — either deepen it or convert the core insight to a trait instead.**

Good skill examples (general methodologies):
- "How to decompose an ambiguous feature request into testable increments"
- "How to diagnose a user's real intent when their first message is vague"
- "How to structure a code review critique that's actionable, not just picky"

Bad skill examples (too narrow, too shallow):
- "How to fix X error in library Y" → that's a code comment, not a skill
- "Steps: 1. read file 2. check error 3. fix it" → too obvious
- "How to use markdown minimally in slidev" → too specific to one tool

### → Memory  (use \`remember\` — only if neither above fits)
Durable facts about the leader, the project, or the world that aren't
behavior and aren't procedures. Most self-review insights are NOT this
shape — prefer trait or skill first.

### Rules for all three
- Ground each one in a specific turn of the transcripts you just read. If
  you can't point at the evidence, don't write it.
- Check for duplicates before creating. If a similar trait/skill/memory
  already exists, update it instead of adding a near-copy.
- Be confident or don't write it. Speculation pollutes future runs.
- Cap yourself: at most 3 new traits, 1 new skill, 1 new memory per run.
  Most runs should produce traits and zero skills — a skill worth writing
  is a rare event. If you found more, the top ones win; the rest wait.
- When in doubt between trait and skill, choose trait. A one-sentence
  behavioral rule that fires every conversation beats a shallow document
  that collects dust.

## Rules for the whole pass
- Ground every critique in a specific turn of the actual transcript. If you
  can't point at the evidence, don't claim it.
- Do NOT modify any threads, settings, or config. Read-only on conversation
  data.
- Do NOT send notifications or channel messages.
- Keep the final written report under ~600 words. Density over volume.
- If nothing meaningful came up, say so plainly. A short honest report beats
  a padded one.`

// ── Registry ───────────────────────────────────────────────────────────

export const BUNDLED_SCHEDULES: readonly BundledScheduleSpec[] = [
  {
    id: 'bundled:self-review',
    name: 'Self-Review',
    cronExpression: '0 12 * * *', // every day at 12:00 PM (high noon)
    prompt: SELF_REVIEW_PROMPT
  }
]

/** Check whether a schedule ID belongs to a bundled schedule. */
export function isBundledScheduleId(id: string): boolean {
  return id.startsWith(BUNDLED_ID_PREFIX)
}

/** Look up the spec for a bundled schedule by ID. */
export function getBundledScheduleSpec(id: string): BundledScheduleSpec | undefined {
  return BUNDLED_SCHEDULES.find((s) => s.id === id)
}
