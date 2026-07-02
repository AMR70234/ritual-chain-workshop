// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrecompileConsumer} from "./utils/PrecompileConsumer.sol";

/// @title AIBountyJudgeCommitReveal
/// @notice Required-Track extension of the workshop's AIJudge contract.
///         Answers are hidden as commitments during the submission phase and only
///         become readable during a separate reveal phase, after which the owner
///         triggers a single batched Ritual LLM judging call (same precompile flow
///         as the original AIJudge.judgeAll) and finally picks a winner.
contract AIBountyJudgeCommitReveal is PrecompileConsumer {
    uint256 public constant MAX_SUBMISSIONS = 10;
    uint256 public constant MAX_ANSWER_LENGTH = 2_000;

    uint256 public nextBountyId = 1;

    // Kept for parity with the workshop's AIJudge contract / front-end expectations.
    // Not required by the commit-reveal logic itself.
    IRitualWallet wallet =
        IRitualWallet(0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948);

    struct Commitment {
        address participant;
        bytes32 commitment; // keccak256(answer, salt, participant, bountyId)
        bool revealed;
    }

    struct Submission {
        address submitter;
        string answer;
    }

    struct Bounty {
        address owner;
        string title;
        string rubric;
        uint256 reward;
        uint256 submissionDeadline;
        uint256 revealDeadline;
        bool judged;
        bool finalized;
        bytes aiReview;
        uint256 winnerIndex;
        Commitment[] commitments; // one per participant, in submission order
        Submission[] submissions; // populated only as reveals succeed
    }

    struct ConvoHistory {
        string storageType;
        string path;
        string secretsName;
    }

    mapping(uint256 => Bounty) public bounties;

    // bountyId => participant => index into commitments[] (+1, so 0 means "not committed")
    mapping(uint256 => mapping(address => uint256)) private commitmentIndex;

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        string title,
        uint256 reward,
        uint256 submissionDeadline,
        uint256 revealDeadline
    );

    event CommitmentSubmitted(
        uint256 indexed bountyId,
        address indexed participant,
        bytes32 commitment
    );

    event AnswerRevealed(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter
    );

    event AllAnswersJudged(uint256 indexed bountyId, bytes aiReview);

    event WinnerFinalized(
        uint256 indexed bountyId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 reward
    );

    modifier onlyOwner(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].owner, "not bounty owner");
        _;
    }

    modifier bountyExists(uint256 bountyId) {
        require(bounties[bountyId].owner != address(0), "bounty not found");
        _;
    }

    // ---------------------------------------------------------------------
    // Bounty creation
    // ---------------------------------------------------------------------

    function createBounty(
        string calldata title,
        string calldata rubric,
        uint256 submissionDeadline,
        uint256 revealDeadline
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(submissionDeadline > block.timestamp, "bad submission deadline");
        require(revealDeadline > submissionDeadline, "bad reveal deadline");

        bountyId = nextBountyId++;

        Bounty storage bounty = bounties[bountyId];

        bounty.owner = msg.sender;
        bounty.title = title;
        bounty.rubric = rubric;
        bounty.reward = msg.value;
        bounty.submissionDeadline = submissionDeadline;
        bounty.revealDeadline = revealDeadline;
        bounty.winnerIndex = type(uint256).max;

        emit BountyCreated(
            bountyId,
            msg.sender,
            title,
            msg.value,
            submissionDeadline,
            revealDeadline
        );
    }

    // ---------------------------------------------------------------------
    // Commit phase — only a hash is stored, answer stays hidden
    // ---------------------------------------------------------------------

    /// @dev commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
    function submitCommitment(
        uint256 bountyId,
        bytes32 commitment
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp < bounty.submissionDeadline, "submissions closed");
        require(!bounty.judged, "already judged");
        require(!bounty.finalized, "already finalized");
        require(
            bounty.commitments.length < MAX_SUBMISSIONS,
            "too many submissions"
        );
        require(commitmentIndex[bountyId][msg.sender] == 0, "already committed");

        bounty.commitments.push(
            Commitment({
                participant: msg.sender,
                commitment: commitment,
                revealed: false
            })
        );
        commitmentIndex[bountyId][msg.sender] = bounty.commitments.length; // index + 1

        emit CommitmentSubmitted(bountyId, msg.sender, commitment);
    }

    // ---------------------------------------------------------------------
    // Reveal phase — answer becomes readable only if it matches the commitment
    // ---------------------------------------------------------------------

    function revealAnswer(
        uint256 bountyId,
        string calldata answer,
        bytes32 salt
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp >= bounty.submissionDeadline, "reveal not open yet");
        require(block.timestamp < bounty.revealDeadline, "reveal closed");
        require(!bounty.judged, "already judged");
        require(!bounty.finalized, "already finalized");
        require(bytes(answer).length <= MAX_ANSWER_LENGTH, "answer too long");

        uint256 idxPlusOne = commitmentIndex[bountyId][msg.sender];
        require(idxPlusOne != 0, "no commitment found");

        Commitment storage c = bounty.commitments[idxPlusOne - 1];
        require(!c.revealed, "already revealed");

        bytes32 expected = keccak256(
            abi.encodePacked(answer, salt, msg.sender, bountyId)
        );
        require(expected == c.commitment, "commitment mismatch");

        c.revealed = true;

        bounty.submissions.push(
            Submission({submitter: msg.sender, answer: answer})
        );

        emit AnswerRevealed(
            bountyId,
            bounty.submissions.length - 1,
            msg.sender
        );
    }

    // ---------------------------------------------------------------------
    // Judging — identical Ritual LLM precompile flow to the workshop's AIJudge,
    // but only runs after the reveal window closes, and only over revealed answers.
    // ---------------------------------------------------------------------

    function judgeAll(
        uint256 bountyId,
        bytes calldata llmInput
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp >= bounty.revealDeadline, "reveal still open");
        require(!bounty.judged, "already judged");
        require(!bounty.finalized, "already finalized");
        require(bounty.submissions.length > 0, "no revealed submissions");

        bytes memory output = _executePrecompile(
            LLM_INFERENCE_PRECOMPILE,
            llmInput
        );

        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(output, (bool, bytes, bytes, string, ConvoHistory));

        require(!hasError, errorMessage);

        bounty.judged = true;
        bounty.aiReview = completionData;

        emit AllAnswersJudged(bountyId, completionData);
    }

    // ---------------------------------------------------------------------
    // Finalization — human owner confirms the payout
    // ---------------------------------------------------------------------

    function finalizeWinner(
        uint256 bountyId,
        uint256 winnerIndex
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.judged, "not judged yet");
        require(!bounty.finalized, "already finalized");
        require(winnerIndex < bounty.submissions.length, "invalid index");

        bounty.finalized = true;
        bounty.winnerIndex = winnerIndex;

        address winner = bounty.submissions[winnerIndex].submitter;
        uint256 reward = bounty.reward;
        bounty.reward = 0;

        (bool ok, ) = payable(winner).call{value: reward}("");
        require(ok, "payment failed");

        emit WinnerFinalized(bountyId, winnerIndex, winner, reward);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Core bounty info (kept separate from getBountyStatus to avoid a
    ///         "stack too deep" compiler error from returning too many values
    ///         out of a single function).
    function getBounty(
        uint256 bountyId
    )
        external
        view
        bountyExists(bountyId)
        returns (
            address owner,
            string memory title,
            string memory rubric,
            uint256 reward,
            uint256 submissionDeadline,
            uint256 revealDeadline
        )
    {
        Bounty storage bounty = bounties[bountyId];

        return (
            bounty.owner,
            bounty.title,
            bounty.rubric,
            bounty.reward,
            bounty.submissionDeadline,
            bounty.revealDeadline
        );
    }

    /// @notice Judging/finalization status for a bounty. Split out from getBounty
    ///         to keep each function's return list small enough for the Solidity
    ///         compiler's stack limits.
    function getBountyStatus(
        uint256 bountyId
    )
        external
        view
        bountyExists(bountyId)
        returns (
            bool judged,
            bool finalized,
            uint256 commitmentCount,
            uint256 revealedCount,
            uint256 winnerIndex,
            bytes memory aiReview
        )
    {
        Bounty storage bounty = bounties[bountyId];

        return (
            bounty.judged,
            bounty.finalized,
            bounty.commitments.length,
            bounty.submissions.length,
            bounty.winnerIndex,
            bounty.aiReview
        );
    }

    /// @notice Commitment info only — never leaks the plaintext answer before reveal.
    function getCommitment(
        uint256 bountyId,
        address participant
    )
        external
        view
        bountyExists(bountyId)
        returns (bytes32 commitment, bool revealed)
    {
        uint256 idxPlusOne = commitmentIndex[bountyId][participant];
        require(idxPlusOne != 0, "no commitment found");
        Commitment storage c = bounties[bountyId].commitments[idxPlusOne - 1];
        return (c.commitment, c.revealed);
    }

    /// @notice Only returns data for indices that have actually been revealed —
    ///         the submissions array only ever contains revealed answers.
    function getSubmission(
        uint256 bountyId,
        uint256 index
    )
        external
        view
        bountyExists(bountyId)
        returns (address submitter, string memory answer)
    {
        Bounty storage bounty = bounties[bountyId];

        require(index < bounty.submissions.length, "invalid index");

        Submission storage submission = bounty.submissions[index];

        return (submission.submitter, submission.answer);
    }
}

interface IRitualWallet {
    function deposit(uint256 lockDuration) external payable;

    function depositFor(address user, uint256 lockDuration) external payable;

    function withdraw(uint256 amount) external;

    function balanceOf(address) external view returns (uint256);

    function lockUntil(address) external view returns (uint256);
}
