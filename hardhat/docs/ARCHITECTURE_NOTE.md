# Architecture Note — Commit-Reveal vs. Ritual-Native Encrypted Submissions

## 1. Comparison

| | Commit-Reveal (Required Track) | Ritual-Native Encrypted (Advanced Track) |
|---|---|---|
| What's on-chain during submission | A hash only (`bytes32`) | An encrypted blob or a reference/hash to an encrypted blob |
| When plaintext becomes visible | The moment each participant reveals — **before** AI judging runs | Only inside the TEE, at judging time; never visible on-chain or to other participants before the reveal step |
| Who can read plaintext, and when | Anyone, once a participant reveals (public mempool/state) | Only the TEE-based executor, during judging; the public only sees the post-judging revealed bundle |
| Copying risk | Low but non-zero: a participant who reveals early (e.g. right after the submission deadline, before others reveal) can still be read by remaining revealers before *they* reveal | Effectively eliminated: no plaintext ever exists outside the TEE until after judging is final |
| Chain requirements | Works on any EVM chain, no special infra | Needs a Ritual-compatible TEE executor / encrypted key flow |
| Gas / storage cost | Cheap: one `bytes32` per submission, plus a string during reveal | Cheap on-chain (store hash/reference only); cost shifts to off-chain encryption + TEE execution |
| Implementation complexity | Low | Higher — needs encryption key management, TEE attestation trust, off-chain storage |

**Key point:** commit-reveal removes the *pre-submission-deadline* copying problem, but it
reopens a smaller window during the reveal phase itself — early revealers are exposed to
later revealers for the remainder of the reveal window. The Ritual-native design closes
that window completely by never putting plaintext on a public chain at all.

## 2. Advanced Track Design: Ritual-Native Hidden Submissions

### Where plaintext answers exist and who can read them
Plaintext answers exist in exactly two places: (1) briefly in the participant's own
client before encryption, and (2) inside the Ritual TEE executor's memory during the
`judgeAll` batch judging step. No other party — not the bounty owner, not other
participants, not even node operators outside the attested TEE — can read plaintext at
any point before the final reveal.

### What's stored on-chain vs. off-chain
- **On-chain:** a per-participant ciphertext reference/hash (e.g. `bytes32 encryptedRef`
  pointing at an off-chain blob, or the ciphertext hash itself if the blob is small),
  bounty metadata/deadlines, the final `winnerIndex`, and `revealedAnswersHash` +
  `revealedAnswersRef` after judging.
- **Off-chain:** the actual ciphertexts (e.g. on IPFS/Arweave/storage-ref, encrypted to
  the TEE's public key or a Ritual-managed key), and after judging, the plaintext
  "revealed answers bundle" referenced by `revealedAnswersRef`.

### How the LLM receives all submissions together
During `judgeAll`, the contract (or an off-chain relayer watching for the `judgeAll`
call) triggers a single Ritual job: the TEE executor fetches all participants'
ciphertexts, decrypts them privately inside the enclave, assembles one batched prompt
containing every revealed-to-the-TEE answer plus the rubric, and makes **one** LLM
request — never a per-submission loop. The TEE returns a signed/attested result
(ranking, winner index, reasoning) which is what `onJudgeResult` records on-chain.

### How the final reveal happens
After judging, the TEE (or the relayer acting on its output) publishes a bundle of all
plaintext answers plus the ranking to off-chain storage and computes
`revealedAnswersHash = keccak256(bundle)`. The contract stores `revealedAnswersRef` and
`revealedAnswersHash` via `onJudgeResult`'s payload. This makes the reveal happen exactly
once, for everyone, at the same moment — no participant is ever exposed to another's
answer before that point.

### How the contract verifies/commits to the final revealed bundle
The contract doesn't re-derive the bundle itself (too expensive on-chain); instead it
stores `revealedAnswersHash` as a commitment. Anyone can later fetch
`revealedAnswersRef`, hash it locally, and check it against `revealedAnswersHash` —
identical trust model to the required track's commit-reveal, just applied to the *output*
bundle instead of individual inputs. This gives auditability without requiring the chain
to trust the TEE blindly forever — the attestation plus the hash-check together let
anyone verify after the fact that the published bundle matches what the TEE actually
judged.

### Avoiding large on-chain plaintext
Only hashes/references go on-chain (`encryptedRef`, `revealedAnswersHash`,
`revealedAnswersRef`). Ciphertexts and the final plaintext bundle live in off-chain
storage (IPFS/Arweave/storage-ref), keeping gas costs flat regardless of answer length or
participant count.

## 3. Minimal Advanced Track sketch (design-level, not implemented)

```solidity
function submitEncrypted(uint256 bountyId, bytes32 encryptedRef) external;
// stores only a reference to an off-chain ciphertext, keyed by (bountyId, msg.sender)

function judgeAll(uint256 bountyId) external onlyBountyOwner(bountyId);
// emits a JudgingRequested event; off-chain Ritual relayer picks it up,
// TEE fetches all encryptedRefs, decrypts, batches, calls LLM once

function onJudgeResult(
    uint256 bountyId,
    uint256 winnerIndex,
    bytes32 revealedAnswersHash,
    string calldata revealedAnswersRef
) external onlyRitualJudge;
// TEE-attested result; contract stores hash+ref, status -> Judged

function finalizeWinner(uint256 bountyId) external onlyBountyOwner(bountyId);
// human owner confirms payout to participants[winnerIndex]
```

This keeps the same human-in-the-loop finalization and single-batch-judging properties
as the required track, while removing the reveal-phase plaintext exposure entirely.
