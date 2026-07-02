# Test Plan — AIBountyJudge

Framework assumption: Foundry (`forge test`), using `vm.warp` for deadlines and
`vm.prank`/`vm.deal` for actors. Each test below is a discrete `test_...` function.

## 1. Bounty creation

| Test | Expectation |
|---|---|
| `test_createBounty_success` | Reward escrowed, deadlines stored, status = `Open`, `BountyCreated` emitted. |
| `test_createBounty_revertsZeroReward` | `msg.value == 0` reverts with `InvalidReward`. |
| `test_createBounty_revertsBadDeadlines` | `submissionDeadline <= now` or `revealDeadline <= submissionDeadline` reverts with `InvalidDeadlines`. |

## 2. Commitment phase (`submitCommitment`)

| Test | Expectation |
|---|---|
| `test_submitCommitment_success` | Commitment stored, `hasCommitted` true, participant appended, event emitted. |
| `test_submitCommitment_revertsAfterDeadline` | Warp past `submissionDeadline` → reverts `SubmissionClosed`. |
| `test_submitCommitment_revertsDuplicate` | Second commit from same address reverts `AlreadyCommitted`. |
| `test_submitCommitment_multipleParticipants` | Two+ distinct addresses can each commit once; order preserved for indexing. |

## 3. Reveal phase (`revealAnswer`) — the core of the required track

| Test | Expectation |
|---|---|
| `test_reveal_validMatch_success` | Correct `(answer, salt)` recomputes to stored commitment → `revealed = true`, answer stored, event emitted. |
| `test_reveal_revertsBeforeSubmissionDeadline` | Calling before `submissionDeadline` reverts `RevealNotOpen`. |
| `test_reveal_revertsAfterRevealDeadline` | Warp past `revealDeadline` reverts `RevealNotOpen`. |
| `test_reveal_revertsWrongSalt` | Correct answer, wrong salt → hash mismatch → reverts `CommitmentMismatch`. |
| `test_reveal_revertsWrongAnswer` | Correct salt, tampered answer string → reverts `CommitmentMismatch`. |
| `test_reveal_revertsNoCommitment` | Address that never committed calls reveal → reverts `NoCommitmentFound`. |
| `test_reveal_revertsDoubleReveal` | Valid reveal followed by a second reveal attempt (even with correct data) → reverts `AlreadyRevealed`. |
| `test_reveal_revertsCannotReplayAnotherUsersCommitment` | Attacker resubmits victim's known `(answer, salt)` from attacker's own address — hash includes `msg.sender`, so it won't match attacker's own (nonexistent/different) commitment → reverts `NoCommitmentFound` or `CommitmentMismatch`. Confirms `msg.sender` binding in the hash prevents commitment theft. |
| `test_reveal_unrevealedNotEligibleForJudging` | A participant who committed but never revealed is excluded from `llmInput` built by the owner / off-chain script; contract state shows `revealed == false` for them. |

## 4. Judging (`judgeAll`, `onJudgeResult`)

| Test | Expectation |
|---|---|
| `test_judgeAll_revertsBeforeRevealDeadline` | Owner calls before `revealDeadline` → reverts `RevealStillOpen`. |
| `test_judgeAll_revertsNotOwner` | Non-owner calling `judgeAll` reverts `NotOwner`. |
| `test_judgeAll_success` | After `revealDeadline`, owner call moves status to `Judging`, stores `llmInput`, emits `JudgingRequested`. |
| `test_onJudgeResult_revertsNotRitualJudge` | Any address other than `ritualJudge` calling `onJudgeResult` reverts `NotRitualJudge`. |
| `test_onJudgeResult_revertsWrongStatus` | Calling before `judgeAll` (status still `Revealing`) reverts `WrongStatus`. |
| `test_onJudgeResult_success` | `ritualJudge` call stores result, moves status to `Judged`, emits `JudgingResultRecorded`. |

## 5. Finalization (`finalizeWinner`)

| Test | Expectation |
|---|---|
| `test_finalizeWinner_revertsBeforeJudged` | Status not `Judged` → reverts `WrongStatus`. |
| `test_finalizeWinner_revertsNotOwner` | Non-owner reverts `NotOwner`. |
| `test_finalizeWinner_revertsInvalidIndex` | `winnerIndex >= participants.length` reverts `InvalidWinnerIndex`. |
| `test_finalizeWinner_revertsWinnerNotRevealed` | Index points at a participant who committed but never revealed → reverts `WinnerNotRevealed`. |
| `test_finalizeWinner_success_paysReward` | Valid call: reward transferred to winner, `b.reward` zeroed, status `Finalized`, event emitted. |
| `test_finalizeWinner_revertsDoubleFinalize` | Calling again after success reverts `WrongStatus` (status no longer `Judged`). |

## 6. Edge cases / fuzzing

- Fuzz `submitCommitment`/`revealAnswer` over random `(answer, salt)` byte strings to confirm hash matching is exact and case/byte-sensitive.
- Fuzz timestamps around `submissionDeadline`/`revealDeadline` boundaries (off-by-one at `== deadline`) since the contract uses strict `>`/`<=` comparisons — verify the boundary timestamp itself belongs to the *earlier* phase.
- Reentrancy check on `finalizeWinner`'s ETH transfer: reward is zeroed (`b.reward = 0`) **before** the external call, and status is already `Finalized` before transfer, so a malicious winner contract re-entering `finalizeWinner` hits `WrongStatus` immediately. Add a dedicated `test_finalizeWinner_reentrancyBlocked` test with a malicious receiver mock.
- Gas check: `judgeAll` and reveal should not scale linearly with participant count in an unbounded way for realistic bounty sizes (document expected participant count assumptions).
