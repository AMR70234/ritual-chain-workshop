import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  keccak256,
  encodePacked,
  toHex,
  getAddress,
  parseEther,
} from "viem";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMISSION_WINDOW_SECS = 3600;
const REVEAL_WINDOW_SECS = 3600;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors: keccak256(abi.encodePacked(answer, salt, sender, bountyId)) */
function computeCommitment(
  answer: string,
  salt: `0x${string}`,
  sender: `0x${string}`,
  bountyId: bigint
): `0x${string}` {
  return keccak256(
    encodePacked(
      ["string", "bytes32", "address", "uint256"],
      [answer, salt, sender, bountyId]
    )
  );
}

function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Runs `fn` and asserts it throws/rejects. */
async function expectRevert(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `expected "${label}" to revert, but it did not`);
}

/**
 * Deploys a brand-new AIBountyJudgeCommitReveal contract for this test only.
 * No snapshot caching is used, so every test is fully isolated from every
 * other test — no shared bounty/commitment state can leak between them.
 */
async function setup() {
  const { viem, networkHelpers } = await network.connect();

  const bounty = await viem.deployContract("AIBountyJudgeCommitReveal");
  const [owner, alice, bob] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  return { bounty, owner, alice, bob, publicClient, networkHelpers };
}

/** Creates bounty #1 on a freshly-deployed contract instance and returns its deadlines. */
async function createBounty(
  bounty: any,
  owner: any,
  publicClient: any,
  reward = parseEther("1")
) {
  const latest = await publicClient.getBlock();
  const submissionDeadline = latest.timestamp + BigInt(SUBMISSION_WINDOW_SECS);
  const revealDeadline = submissionDeadline + BigInt(REVEAL_WINDOW_SECS);

  const hash = await owner.writeContract({
    address: bounty.address,
    abi: bounty.abi,
    functionName: "createBounty",
    args: ["Test Bounty", "Best answer wins", submissionDeadline, revealDeadline],
    value: reward,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  // First bounty on a fresh contract is always id 1.
  return { bountyId: 1n, submissionDeadline, revealDeadline };
}

/** setup() + createBounty() + alice submits a commitment. */
async function committedSetup() {
  const base = await setup();
  const { bounty, owner, alice, publicClient } = base;
  const { bountyId, submissionDeadline, revealDeadline } = await createBounty(
    bounty,
    owner,
    publicClient
  );

  const answer = "42 is the answer";
  const salt = randomSalt();
  const commitment = computeCommitment(
    answer,
    salt,
    getAddress(alice.account.address),
    bountyId
  );
  const hash = await alice.writeContract({
    address: bounty.address,
    abi: bounty.abi,
    functionName: "submitCommitment",
    args: [bountyId, commitment],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { ...base, bountyId, submissionDeadline, revealDeadline, answer, salt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AIBountyJudgeCommitReveal", async function () {
  describe("createBounty", async function () {
    it("stores bounty data and escrows the reward", async function () {
      const { bounty, owner, publicClient } = await setup();
      const { bountyId, submissionDeadline, revealDeadline } =
        await createBounty(bounty, owner, publicClient);

      const [bOwner, title, rubric, reward, subDl, revDl] =
        await bounty.read.getBounty([bountyId]);

      assert.equal(getAddress(bOwner), getAddress(owner.account.address));
      assert.equal(title, "Test Bounty");
      assert.equal(rubric, "Best answer wins");
      assert.equal(reward, parseEther("1"));
      assert.equal(subDl, submissionDeadline);
      assert.equal(revDl, revealDeadline);
    });

    it("reverts with zero reward", async function () {
      const { bounty, owner, publicClient } = await setup();
      const latest = await publicClient.getBlock();
      await expectRevert(
        () =>
          owner.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "createBounty",
            args: [
              "No reward",
              "rubric",
              latest.timestamp + 3600n,
              latest.timestamp + 7200n,
            ],
            value: 0n,
          }),
        "zero reward"
      );
    });

    it("reverts when revealDeadline is not after submissionDeadline", async function () {
      const { bounty, owner, publicClient } = await setup();
      const latest = await publicClient.getBlock();
      const submissionDeadline = latest.timestamp + 3600n;
      await expectRevert(
        () =>
          owner.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "createBounty",
            args: ["Bad deadlines", "rubric", submissionDeadline, submissionDeadline],
            value: parseEther("1"),
          }),
        "bad deadlines"
      );
    });
  });

  describe("submitCommitment", async function () {
    it("accepts a commitment before the submission deadline", async function () {
      const { bounty, owner, alice, publicClient } = await setup();
      const { bountyId } = await createBounty(bounty, owner, publicClient);

      const salt = randomSalt();
      const commitment = computeCommitment(
        "my answer",
        salt,
        getAddress(alice.account.address),
        bountyId
      );

      const hash = await alice.writeContract({
        address: bounty.address,
        abi: bounty.abi,
        functionName: "submitCommitment",
        args: [bountyId, commitment],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const [storedCommitment, revealed] = await bounty.read.getCommitment([
        bountyId,
        alice.account.address,
      ]);
      assert.equal(storedCommitment, commitment);
      assert.equal(revealed, false);
    });

    it("reverts on a duplicate commitment from the same address", async function () {
      const { bounty, alice, bountyId } = await committedSetup();

      const dupCommitment = computeCommitment(
        "a different answer",
        randomSalt(),
        getAddress(alice.account.address),
        bountyId
      );

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "submitCommitment",
            args: [bountyId, dupCommitment],
          }),
        "duplicate commitment"
      );
    });

    it("reverts once the submission deadline has passed", async function () {
      const { bounty, owner, alice, publicClient, networkHelpers } = await setup();
      const { bountyId } = await createBounty(bounty, owner, publicClient);

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      const commitment = computeCommitment(
        "too late",
        randomSalt(),
        getAddress(alice.account.address),
        bountyId
      );
      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "submitCommitment",
            args: [bountyId, commitment],
          }),
        "commitment after deadline"
      );
    });
  });

  describe("revealAnswer", async function () {
    it("accepts a valid reveal after the submission deadline", async function () {
      const { bounty, alice, publicClient, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      const hash = await alice.writeContract({
        address: bounty.address,
        abi: bounty.abi,
        functionName: "revealAnswer",
        args: [bountyId, answer, salt],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const [, revealed] = await bounty.read.getCommitment([
        bountyId,
        alice.account.address,
      ]);
      assert.equal(revealed, true);

      const [submitter, storedAnswer] = await bounty.read.getSubmission([
        bountyId,
        0n,
      ]);
      assert.equal(getAddress(submitter), getAddress(alice.account.address));
      assert.equal(storedAnswer, answer);
    });

    it("reverts before the submission deadline has passed", async function () {
      const { bounty, alice, bountyId, answer, salt } = await committedSetup();

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, salt],
          }),
        "reveal before submission deadline"
      );
    });

    it("reverts after the reveal deadline has passed", async function () {
      const { bounty, alice, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(
        SUBMISSION_WINDOW_SECS + REVEAL_WINDOW_SECS + 5
      );

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, salt],
          }),
        "reveal after reveal deadline"
      );
    });

    it("reverts with the wrong salt", async function () {
      const { bounty, alice, networkHelpers, bountyId, answer } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, randomSalt()],
          }),
        "wrong salt"
      );
    });

    it("reverts with a tampered answer", async function () {
      const { bounty, alice, networkHelpers, bountyId, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, "a different answer", salt],
          }),
        "tampered answer"
      );
    });

    it("reverts for an address that never committed", async function () {
      const { bounty, bob, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      await expectRevert(
        () =>
          bob.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, salt],
          }),
        "reveal with no commitment"
      );
    });

    it("reverts on a double reveal", async function () {
      const { bounty, alice, publicClient, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      const hash = await alice.writeContract({
        address: bounty.address,
        abi: bounty.abi,
        functionName: "revealAnswer",
        args: [bountyId, answer, salt],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      await expectRevert(
        () =>
          alice.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, salt],
          }),
        "double reveal"
      );
    });

    it("cannot be replayed by another address (msg.sender is bound into the hash)", async function () {
      const { bounty, bob, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);

      // Bob never committed, so revealing Alice's known (answer, salt) as Bob
      // must fail — Bob has no commitment index at all.
      await expectRevert(
        () =>
          bob.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "revealAnswer",
            args: [bountyId, answer, salt],
          }),
        "replay by another address"
      );
    });

    it("leaves unrevealed submissions out of the submissions array used for judging", async function () {
      const { bounty, bountyId } = await committedSetup();

      const [, , commitmentCount, revealedCount] = await bounty.read.getBountyStatus([
        bountyId,
      ]);
      assert.equal(commitmentCount, 1n);
      assert.equal(revealedCount, 0n); // Alice committed but has not revealed yet
    });
  });

  describe("judgeAll / finalizeWinner", async function () {
    it("reverts judgeAll before the reveal deadline has passed", async function () {
      const { bounty, owner, alice, publicClient, networkHelpers, bountyId, answer, salt } =
        await committedSetup();

      await networkHelpers.time.increase(SUBMISSION_WINDOW_SECS + 5);
      const hash = await alice.writeContract({
        address: bounty.address,
        abi: bounty.abi,
        functionName: "revealAnswer",
        args: [bountyId, answer, salt],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      // Reveal deadline has NOT passed yet -> judgeAll must revert
      await expectRevert(
        () =>
          owner.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "judgeAll",
            args: [bountyId, "0x"],
          }),
        "judgeAll before reveal deadline"
      );
    });

    it("reverts finalizeWinner before judging is complete", async function () {
      const { bounty, owner, publicClient } = await setup();
      const { bountyId } = await createBounty(bounty, owner, publicClient);

      await expectRevert(
        () =>
          owner.writeContract({
            address: bounty.address,
            abi: bounty.abi,
            functionName: "finalizeWinner",
            args: [bountyId, 0n],
          }),
        "finalize before judged"
      );
    });

    // NOTE: judgeAll's success path calls the real LLM_INFERENCE_PRECOMPILE
    // (address 0x0802), which only exists on an actual Ritual node/testnet.
    // On Hardhat's locally simulated network there is no code at that
    // address, so a full judgeAll -> finalizeWinner happy-path test can only
    // be run against `sepolia`/`ritual` network connections (or with a mock
    // precompile deployed at that address in a forked environment). See
    // docs/TEST_PLAN.md for the manual/testnet test plan covering this path.
  });
});
