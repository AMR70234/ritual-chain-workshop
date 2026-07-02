# Reflection

**What should be public, what should stay hidden, and what should be decided by AI
versus by a human in a bounty system?**

Bounty metadata — the reward amount, deadlines, rules, and the eventual winner — should
be public from the start, since participants need that information to decide whether to
compete and to trust that the process is fair. Submitted answers, by contrast, should
stay completely hidden during the active competition window: the moment one answer is
readable while others are still being written, the bounty stops rewarding independent
effort and starts rewarding whoever reads last. Commitments (hashes) are a reasonable
public artifact even during the hidden phase, since they prove a participant submitted
something at a given time without leaking content. Judging itself is a good fit for AI
because it can consistently apply a rubric to many submissions at once, batch the work
into a single request instead of biasing early or late entries, and produce a
transparent, explainable ranking. But AI should only *recommend* — the final decision to
pay out a specific winner should stay with a human, because AI output can be wrong,
manipulated by prompt injection inside a submitted answer, or simply misaligned with
intent the rubric didn't capture, and real money is on the line. In short: process rules
and outcomes are public, in-progress content is hidden, AI ranks, and a human commits.
