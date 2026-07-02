import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("AIBountyJudgeCommitRevealModule", (m) => {
  const aiBountyJudgeCommitReveal = m.contract("AIBountyJudgeCommitReveal");

  return { aiBountyJudgeCommitReveal };
});
