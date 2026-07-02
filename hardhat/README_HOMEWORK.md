# AI Bounty Judge — Commit-Reveal Edition

This repo extends the workshop AI Bounty Judge so answers stay hidden until judging
is complete, preventing later participants from copying earlier ideas.

## Lifecycle

1. **Create** — `createBounty(submissionDeadline, revealDeadline)` (payable). The owner
   locks the reward in the contract and sets two deadlines.
2. **Commit (Open phase)** — Each participant calls `submitCommitment(bountyId, commitment)`
   with `commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))`.
   Only the hash is stored on-chain — no one, including the bounty owner, can read the
   answer yet. One commitment per address per bounty.
3. **Reveal (Revealing phase)** — After `submissionDeadline` and before `revealDeadline`,
   each participant calls `revealAnswer(bountyId, answer, salt)`. The contract recomputes
   the hash and only accepts the reveal if it matches the original commitment. Binding
   `msg.sender` and `bountyId` into the hash stops one participant from replaying or
   claiming someone else's commitment.
4. **Judge** — After `revealDeadline`, the owner calls `judgeAll(bountyId, llmInput)`,
   moving the bounty to `Judging`. `llmInput` bundles **all** revealed answers into a
   single payload — there is no per-submission loop calling an LLM. This models handing
   the batch off to a Ritual AI judging job.
5. **Judging callback** — The authorized `ritualJudge` address (a Ritual executor/relayer
   in production) calls `onJudgeResult(bountyId, result)` once the batch judging job
   finishes, moving the bounty to `Judged`. This keeps the AI call async and off-chain;
   the contract never assumes the LLM call succeeds synchronously.
6. **Finalize** — The owner (human) calls `finalizeWinner(bountyId, winnerIndex)`. The
   AI's ranking is advisory; the owner is the one who commits to a specific winner index
   on-chain, and only then is the reward paid out. This is the human-in-the-loop step.

## Status state machine

```
Open --(submissionDeadline passes)--> Revealing --(revealDeadline passes, owner calls judgeAll)--> Judging
  --(ritualJudge calls onJudgeResult)--> Judged --(owner calls finalizeWinner)--> Finalized
```

Every state transition is enforced by `require`/custom-error checks tied to
`block.timestamp` and `msg.sender`, so no phase can be skipped or reordered.

## Why commit-reveal fixes the fairness bug

In the original workshop contract, `answer` was stored (and readable) the moment a
participant submitted it. A later participant could read all earlier answers and submit
a strictly better version. With commit-reveal:

- During the submission window, only a hash is public — it reveals nothing about the
  answer's content.
- Answers only become public during the reveal window, which opens *after* the
  submission window closes, so there is no submission period during which an answer is
  both submitted and readable by other participants.

This still has one residual leak (see Architecture Note): revealed answers become
public *before* AI judging finishes, which the Advanced Track (Ritual-native encrypted
submissions) removes entirely.

## Files

- `contracts/AIBountyJudge.sol` — Required Track contract.
- `docs/TEST_PLAN.md` — test cases (valid/invalid reveals, access control, timing).
- `docs/ARCHITECTURE_NOTE.md` — commit-reveal vs. Ritual-native comparison + Advanced
  Track design.
- `docs/REFLECTION.md` — answer to the reflection question.
