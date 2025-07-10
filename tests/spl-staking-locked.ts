import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getAccount } from "@solana/spl-token";
import { expect, use } from "chai";
import {
  newUserWithSOL,
  newUserWithSOLAndToken,
  waitForTransaction,
} from "../tests-common-functions";
import {
  getSettingsPDA,
  getStatsPDA,
  getUserInfoPDA,
  takeSnapshot,
  Snapshot,
} from "../tests-specific-functions";

describe("spl-staking-locked", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  type User = {
    user: anchor.web3.Keypair;
    ata: anchor.web3.PublicKey;
  };

  let admin: User;
  let user1: User;
  let user2: User;
  let user3: User;
  let admin2: User;

  // Token owner
  let tokenOwner: Keypair;
  // Token mints
  let tokenMint: PublicKey;

  const eventParser = new anchor.EventParser(
    program.programId,
    new anchor.BorshCoder(program.idl)
  );

  const WITHDRAWAL_DELAY_DAYS = 5;
  const REWARD_RATE_0 = 0;
  const REWARD_RATE_1 = 80_000_000_000; // 8% a year

  const USER1_STAKE_AMOUNT = 100;
  const USER2_STAKE_AMOUNT = 200;
  const USER3_STAKE_AMOUNT = 100;

  let rewardStartedAt;
  let user2FirstRequestRewards = 0;
  let user3FirstRequestRewards = 0;
  let user3FirstRequestTimestamp = 0;
  let user3SecondRequestRewards = 0;

  let snapshots: Snapshot[] = [];

  before(async () => {
    tokenOwner = await newUserWithSOL(provider, 2);
    tokenMint = await createMint(
      provider.connection,
      tokenOwner,
      tokenOwner.publicKey,
      null,
      9
    );

    admin = await newUserWithSOLAndToken(
      provider,
      2,
      tokenMint,
      tokenOwner,
      1000
    );
    user1 = await newUserWithSOLAndToken(
      provider,
      2,
      tokenMint,
      tokenOwner,
      USER1_STAKE_AMOUNT * 2
    );
    user2 = await newUserWithSOLAndToken(
      provider,
      2,
      tokenMint,
      tokenOwner,
      USER2_STAKE_AMOUNT * 2
    );
    user3 = await newUserWithSOLAndToken(
      provider,
      2,
      tokenMint,
      tokenOwner,
      USER3_STAKE_AMOUNT * 2
    );
    admin2 = await newUserWithSOLAndToken(
      provider,
      2,
      tokenMint, // Use same token for admin2
      tokenOwner,
      1000
    );
  });

  it("Initialize pool", async () => {
    const tx = await program.methods
      .initialize(
        new anchor.BN(WITHDRAWAL_DELAY_DAYS),
        new anchor.BN(REWARD_RATE_0)
      )
      .accounts({
        administrator: admin.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([admin.user])
      .rpc();

    // Verify settings state
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.administrator.toString()).to.equal(
      admin.user.publicKey.toString()
    );
    expect(settings.pendingAdministrator).to.be.null;
    expect(settings.tokenMint).to.deep.equal(tokenMint);
    expect(settings.withdrawalDelaySeconds).to.equal(
      WITHDRAWAL_DELAY_DAYS * 24 * 60 * 60
    );
    expect(settings.rewardRatePerSecondPerTokenNumerator.toNumber()).to.equal(
      0
    );
    // expect(settings.rewardRatePerSecondPerTokenNumerator.toNumber()).to.equal(
    //   Math.floor(INITIAL_REWARD_RATE / (365 * 24 * 60 * 60)) // Convert annual rate to per second, floored
    // );

    // Verify stats state
    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.rewardPerTokenStoredNumerator.toNumber()).to.equal(0);
    expect(stats.lastUpdateTime).to.be.greaterThan(0);
    expect(stats.totalRewardPromised.toNumber()).to.equal(0);
    expect(stats.totalRewardProvided.toNumber()).to.equal(0);
  });

  it("   viewUnallocatedRewards is 0", async () => {
    let rsp = await program.methods.viewUnallocatedRewards().simulate();

    expect(rsp.events[0].name).to.equal("unallocatedRewardsViewed");
    expect(rsp.events[0].data.unallocatedRewards.toNumber()).to.equal(0);
  });

  it("   viewUnallocatedRewards is 0 v2", async () => {
    expect(
      (await program.methods.viewUnallocatedRewards().view()).toNumber()
    ).to.equal(0);
  });

  it("   viewRewadRunway in u64::Max", async () => {
    expect(
      (await program.methods.viewRewardRunway().view()).toString()
    ).to.equal("18446744073709551615");
  });

  it(`+ User1 stakes half of the tokens (${USER1_STAKE_AMOUNT}) [total: ${USER1_STAKE_AMOUNT} | staked: ${USER1_STAKE_AMOUNT}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user1.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user1.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user1.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user1.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user1.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.equal(txinfo.blockTime);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(stats.totalRewardPromised.toNumber()).to.equal(0);
    expect(stats.totalRewardProvided.toNumber()).to.equal(0);
    expect(stats.rewardPerTokenStoredNumerator.toNumber()).to.equal(0);

    // Check the token balance of the userInfoPDA's ATA for tokenMint
    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
  });

  it(`+ User2 stakes half of his tokens (${USER2_STAKE_AMOUNT}) [total: ${USER2_STAKE_AMOUNT} | staked: ${USER2_STAKE_AMOUNT}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user2.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user2.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user2.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user2.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.equal(txinfo.blockTime);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      (USER1_STAKE_AMOUNT + USER2_STAKE_AMOUNT) * LAMPORTS_PER_SOL
    );
    expect(stats.totalRewardPromised.toNumber()).to.equal(0);
    expect(stats.totalRewardProvided.toNumber()).to.equal(0);
    expect(stats.rewardPerTokenStoredNumerator.toNumber()).to.equal(0);

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
  });

  it("   ViewCurrentRewards for user1 should be 0 (reward rate is 0)", async () => {
    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user1.user.publicKey,
          })
          .view()
      ).toNumber()
    ).to.eq(0);
  });
  it("   ViewCurrentRewards for user2 should be 0 (reward rate is 0)", async () => {
    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user2.user.publicKey,
          })
          .view()
      ).toNumber()
    ).to.eq(0);
  });

  it(`+ User1 stakes additional ${USER1_STAKE_AMOUNT} tokens [total: ${
    USER1_STAKE_AMOUNT * 2
  } | staked: ${USER1_STAKE_AMOUNT * 2}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user1.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user1.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user1.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user1.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user1.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.within(1, txinfo.blockTime - 1); // Not zero. Not the current time. Should not be updated on stake extension
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      (USER1_STAKE_AMOUNT * 2 + USER2_STAKE_AMOUNT) * LAMPORTS_PER_SOL
    );
    expect(stats.totalRewardPromised.toNumber()).to.equal(0);
    expect(stats.totalRewardProvided.toNumber()).to.equal(0);
    expect(stats.rewardPerTokenStoredNumerator.toNumber()).to.equal(0);

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
  });

  it("   ViewCurrentRewards for user2 still should be 0 (reward rate is 0)", async () => {
    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user2.user.publicKey,
          })
          .view()
      ).toNumber()
    ).to.eq(0);
  });

  it("! Configure reward rate to 8% per year. Still no rewards in the protocol", async () => {
    const expectedRewardRatePerSecondPerTokenNumerator = Math.floor(
      REWARD_RATE_1 / (365 * 24 * 60 * 60)
    );

    const tx = await program.methods
      .configureRewardRatio(new anchor.BN(REWARD_RATE_1))
      .accounts({
        administrator: admin.user.publicKey,
      })
      .signers([admin.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("rewardRatioConfigured");
    expect(events[0].data.administrator).to.deep.eq(admin.user.publicKey);
    expect(
      events[0].data.newRewardRateYearlyPercentageNumerator.toNumber()
    ).to.eq(REWARD_RATE_1);
    expect(
      events[0].data.newRewardRatePerSecondPerTokenNumerator.toNumber()
    ).to.eq(expectedRewardRatePerSecondPerTokenNumerator);

    // Store the curent time as the reward start time
    const slot = await provider.connection.getSlot();
    rewardStartedAt = await provider.connection.getBlockTime(slot);

    // Verify settings state updated
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.rewardRatePerSecondPerTokenNumerator.toNumber()).to.equal(
      expectedRewardRatePerSecondPerTokenNumerator
    );

    // Verify stats state updated
    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    // No rewards yet written to the accumulator
    expect(stats.rewardPerTokenStoredNumerator.toNumber()).to.eq(0);
  });

  it("   📝Snapshot user's positions (0)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });
  it("   User1 and User2 snapshots should be identical (Both had 200 tokens staked, when the rate was set to nonzero)", async () => {
    // expect(snapshots[0].user1.total_reward).to.equal(snapshots[0].user2.total_reward);
    expect(snapshots.at(-1)!.user1.total_reward).to.equal(
      snapshots.at(-1)!.user2.total_reward
    );
  });

  it("   Sleep two seconds to allow rewards to accumulate", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  it("   Both users should have accumulated rewards now", async () => {
    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user1.user.publicKey,
          })
          .view()
      ).toNumber()
    ).gt(0);

    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user2.user.publicKey,
          })
          .view()
      ).toNumber()
    ).gt(0);
  });

  it("   Still, their rewardPerTokenPaidNumerator and capturedReward should be 0", async () => {
    const user1InfoPDA = getUserInfoPDA(
      program.programId,
      user1.user.publicKey
    );
    const user1Info = await program.account.userInfo.fetch(user1InfoPDA);
    expect(user1Info.rewardPerTokenPaidNumerator.toNumber()).to.equal(0);
    expect(user1Info.capturedReward.toNumber()).to.equal(0);

    const user2InfoPDA = getUserInfoPDA(
      program.programId,
      user2.user.publicKey
    );
    const user2Info = await program.account.userInfo.fetch(user2InfoPDA);
    expect(user2Info.rewardPerTokenPaidNumerator.toNumber()).to.equal(0);
    expect(user2Info.capturedReward.toNumber()).to.equal(0);
  });

  it("   ViewUnallocatedRewards should be negative", async () => {
    const unallocatedRewards = await program.methods
      .viewUnallocatedRewards()
      .view();
    expect(unallocatedRewards.toNumber()).to.be.lessThan(0);
  });

  it("   ViewRewardRunway should be zero", async () => {
    const rewardRunway = await program.methods.viewRewardRunway().view();
    expect(rewardRunway.toNumber()).to.equal(0);
  });

  it("   Test consistency: both simulations in same transaction context should match", async () => {
    // Create a single transaction with both instructions
    const transaction = new anchor.web3.Transaction();

    // Add both instructions to the same transaction
    const viewCurrentRewardsIx = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user1.user.publicKey,
      })
      .instruction();

    const requestWithdrawalIx = await program.methods
      .requestWithdrawal()
      .accounts({
        user: user1.user.publicKey,
      })
      .instruction();

    transaction.add(viewCurrentRewardsIx);
    transaction.add(requestWithdrawalIx);

    // Simulate the entire transaction at once
    const result = await provider.connection.simulateTransaction(transaction, [
      user1.user,
    ]);

    // Parse events from the simulation logs
    const events = [...eventParser.parseLogs(result.value.logs)];

    // Find the events from each instruction
    const viewEvent = events.find((e) => e.name === "currentRewardsViewed");
    const withdrawalEvent = events.find(
      (e) => e.name === "withdrawalRequested"
    );

    expect(viewEvent).to.not.be.undefined;
    expect(withdrawalEvent).to.not.be.undefined;
    expect(withdrawalEvent.data.addedRewardAmount.toNumber()).to.equal(
      viewEvent.data.totalReward.toNumber()
    );
  });

  it("   📝Snapshot user's positions (1)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });

  it("   User1 and User2 snapshots should be identical (Both had 200 tokens staked, when the rate was set to nonzero)", async () => {
    expect(snapshots.at(-1)!.user1.total_reward).to.equal(
      snapshots.at(-1)!.user2.total_reward
    );
  });
  it("   User1 and User2 snapshots should correspond to the reward rate", async () => {
    const stakeDuration =
      snapshots.at(-1)!.timestamp - snapshots.at(-2)!.timestamp;
    const expectedReward = Math.floor(
      (stakeDuration * USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL * REWARD_RATE_1) /
        (365 * 24 * 60 * 60) /
        1e12
    );

    const rewardGrowth =
      snapshots.at(-1)!.user1.total_reward -
      snapshots.at(-2)!.user1.total_reward;
    expect(rewardGrowth).to.within(expectedReward - 1, expectedReward + 1);
  });

  it(`- User1 requests withdrawal [total: ${
    2 * USER1_STAKE_AMOUNT
  } | staked: 0]`, async () => {
    const expectedReward = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user1.user.publicKey,
      })
      .view();
    const tx = await program.methods
      .requestWithdrawal()
      .accounts({
        user: user1.user.publicKey,
      })
      .signers([user1.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawalRequested");
    expect(events[0].data.user).to.deep.eq(user1.user.publicKey);
    expect(events[0].data.addedTokenAmount.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalTokenAmount.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(events[0].data.addedRewardAmount.toNumber()).gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.totalRewardAmount.toNumber()).gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.withdrawalRequestTime).to.eq(txinfo.blockTime);

    const userInfoPDA = getUserInfoPDA(program.programId, user1.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.stakedAt).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(txinfo.blockTime);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).gte(
      expectedReward.toNumber()
    );
    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
  });

  it("   User1 not allowed to withdraw straight away", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          user: user1.user.publicKey,
        })
        .signers([user1.user])
        .rpc();
      expect.fail("Withdrawal should not be allowed yet");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("WithdrawalDelayNotMet");
        return;
      } else {
        throw err;
      }
    }
  });

  it("   User1 not allowed to withdraw and forfeit rewards straight away", async () => {
    try {
      await program.methods
        .withdrawAndForfeitRewards()
        .accounts({
          user: user1.user.publicKey,
        })
        .signers([user1.user])
        .rpc();
      expect.fail("Withdrawal should not be allowed yet");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("WithdrawalDelayNotMet");
        return;
      } else {
        throw err;
      }
    }
  });

  it("   User2 not allowed to withdraw (have not requested a withdrawal)", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          user: user2.user.publicKey,
        })
        .signers([user2.user])
        .rpc();
      expect.fail("Withdrawal should not be allowed yet");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("NoWithdrawalRequest");
        return;
      } else {
        throw err;
      }
    }
  });

  it("   User3 not allowed to withdraw (have not staked)", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          user: user3.user.publicKey,
        })
        .signers([user3.user])
        .rpc();
      expect.fail("Withdrawal should not be allowed yet");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("AccountNotInitialized");
        return;
      } else {
        throw err;
      }
    }
  });

  it(`- User2 requests withdrawal [total: ${USER2_STAKE_AMOUNT} | staked: 0]`, async () => {
    const tx = await program.methods
      .requestWithdrawal()
      .accounts({
        user: user2.user.publicKey,
      })
      .signers([user2.user])
      .rpc();
    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawalRequested");
    user2FirstRequestRewards = events[0].data.addedRewardAmount.toNumber();

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(0);

    const userInfoPDA = getUserInfoPDA(program.programId, user2.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.stakedAt).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(txinfo.blockTime);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).gt(0);

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
  });

  it(`+ User2 deposits some more tokens (200 tokens) [total: ${
    USER2_STAKE_AMOUNT * 2
  } | staked: ${USER2_STAKE_AMOUNT}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user2.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user2.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user2.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user2.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.equal(txinfo.blockTime);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.gt(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).eq(
      user2FirstRequestRewards
    );

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER2_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
  });
  it("   📝Snapshot user's positions (2)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });

  it("   User1 accumulates nothing while waiting for withdrawal", async () => {
    expect(
      (
        await program.methods
          .viewCurrentRewards()
          .accounts({
            user: user1.user.publicKey,
          })
          .view()
      ).toNumber()
    ).to.eq(0);

    const user1InfoPDA = getUserInfoPDA(
      program.programId,
      user1.user.publicKey
    );
    const user1Info = await program.account.userInfo.fetch(user1InfoPDA);
    expect(user1Info.capturedReward.toNumber()).to.equal(0);
  });

  it("Admin can initiate ownership transfer to admin2", async () => {
    const tx = await program.methods
      .initiateOwnershipTransfer(admin2.user.publicKey)
      .accounts({
        administrator: admin.user.publicKey,
      })
      .signers([admin.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("ownershipTransferInitiated");
    expect(events[0].data.currentAdministrator).to.deep.eq(
      admin.user.publicKey
    );
    expect(events[0].data.newAdministrator).to.deep.eq(admin2.user.publicKey);

    // Verify settings state updated
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.pendingAdministrator.toString()).to.equal(
      admin2.user.publicKey.toString()
    );
  });

  it("   User3 cannot finalize ownership transfer (not an intended recepient)", async () => {
    try {
      await program.methods
        .finalizeOwnershipTransfer()
        .accounts({
          newAdministrator: user3.user.publicKey,
        })
        .signers([user3.user])
        .rpc();
      expect.fail("User3 should not be able to finalize ownership transfer");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("UnauthorizedOwnershipTransfer");
        return;
      } else {
        throw err;
      }
    }
  });

  it("Admin2 finalizes ownership transfer", async () => {
    const tx = await program.methods
      .finalizeOwnershipTransfer()
      .accounts({
        newAdministrator: admin2.user.publicKey,
      })
      .signers([admin2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("ownershipTransferFinalized");
    expect(events[0].data.oldAdministrator).to.deep.eq(admin.user.publicKey);
    expect(events[0].data.newAdministrator).to.deep.eq(admin2.user.publicKey);

    // Verify settings state updated
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.administrator.toString()).to.equal(
      admin2.user.publicKey.toString()
    );
    expect(settings.pendingAdministrator).to.be.null;
  });

  it("   Admin2 cannot set withdrawal delay to 100 days", async () => {
    try {
      await program.methods
        .configureWithdrawalDelay(new anchor.BN(100 * 24 * 60 * 60))
        .accounts({
          administrator: admin2.user.publicKey,
        })
        .signers([admin2.user])
        .rpc();
      expect.fail("Setting withdrawal delay should not be allowed");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("InvalidAmount");
        return;
      } else {
        throw err;
      }
    }
  });

  it("Admin2 sets withdrawal delay to 0 days, so that we can test the withdrawal", async () => {
    const tx = await program.methods
      .configureWithdrawalDelay(new anchor.BN(0))
      .accounts({
        administrator: admin2.user.publicKey,
      })
      .signers([admin2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawalDelayConfigured");
    expect(events[0].data.administrator).to.deep.eq(admin2.user.publicKey);
    expect(events[0].data.newWithdrawalDelaySeconds).to.eq(0);

    // Verify settings state updated
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.withdrawalDelaySeconds).to.equal(0);
  });

  it("   User1 cannot withdraw, as there is no rewardTokenATA created yet", async () => {
    try {
      await program.methods
        .withdraw()
        .accounts({
          user: user1.user.publicKey,
        })
        .signers([user1.user])
        .rpc();
      expect.fail("Withdrawal should not be allowed yet");
    } catch (err) {
      if ("error" in err && "errorCode" in err.error) {
        expect(err.error.errorCode.code).to.eq("InsufficientRewards");
        return;
      } else {
        throw err;
      }
    }
  });

  it("Admin2 provides rewards to the contract", async () => {
    const AMOUNT = 1000 * LAMPORTS_PER_SOL; // 1000 SOL in lamports
    const tx = await program.methods
      .addRewards(new anchor.BN(AMOUNT))
      .accounts({
        administrator: admin2.user.publicKey,
      })
      .signers([admin2.user])
      .rpc();
    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("rewardsAdded");
    expect(events[0].data.administrator).to.deep.eq(admin2.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(AMOUNT);
  });

  it("   ViewUnallocatedRewards is positive", async () => {
    const unallocatedRewards = await program.methods
      .viewUnallocatedRewards()
      .view();
    expect(unallocatedRewards.toNumber()).to.be.greaterThan(0);
  });

  it("   ViewRewardRunway should be positive", async () => {
    const rewardRunway = await program.methods.viewRewardRunway().view();
    expect(rewardRunway.toNumber()).to.be.greaterThan(0);
  });

  it("- User1 withdraws [total: 0 | staked: 0]", async () => {
    const user1TokenBalanceBefore = Number(
      (await getAccount(provider.connection, user1.ata)).amount
    );
    expect(user1TokenBalanceBefore).to.be.eq(0);
    const tx = await program.methods
      .withdraw()
      .accounts({
        user: user1.user.publicKey,
      })
      .signers([user1.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawn");
    expect(events[0].data.user).to.deep.eq(user1.user.publicKey);
    expect(events[0].data.tokenAmount.toNumber()).to.eq(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(events[0].data.rewardAmount.toNumber()).to.be.greaterThan(0);

    const userInfoPDA = getUserInfoPDA(program.programId, user1.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.stakedAt).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    // Check the token balance of the userInfoPDA's ATA for tokenMint
    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(0);

    // Check the token balance of user1's ATA for tokenMint
    const user1TokenBalanceAfter = Number(
      (await getAccount(provider.connection, user1.ata)).amount
    );
    expect(user1TokenBalanceAfter).to.be.gt(
      USER1_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
  });

  it("   User3 cannot deposit more than he has in his ATA", async () => {
    try {
      await program.methods
        .stake(new anchor.BN(USER3_STAKE_AMOUNT * 1000 * LAMPORTS_PER_SOL))
        .accounts({
          user: user3.user.publicKey,
          tokenMint: tokenMint,
        })
        .signers([user3.user])
        .rpc();
      expect.fail("User3 should not be able to stake more than he has");
    } catch (err) {
      // Handle SPL Token errors and Anchor errors differently
      if (
        err.logs &&
        err.logs.some((log) => log.includes("Error: insufficient funds"))
      ) {
        // This is the SPL Token insufficient funds error
        return;
      } else {
        // Log the full error for debugging
        console.log("Unexpected error:", err);
        console.log("Error logs:", err.logs);
        throw err;
      }
    }
  });

  it(`+ User3 deposits some tokens (100 tokens) [total: ${USER3_STAKE_AMOUNT} | staked: ${USER3_STAKE_AMOUNT}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user3.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user3.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user3.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user3.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user3.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.equal(txinfo.blockTime);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      (USER2_STAKE_AMOUNT + USER3_STAKE_AMOUNT) * LAMPORTS_PER_SOL
    );

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
  });
  it("   📝Snapshot user's positions (3)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });

  it("   User2 accumulated rewards at the predefined rate even while waiting for withdrawal", async () => {
    const stakeDuration =
      snapshots.at(-1)!.timestamp - snapshots.at(-2)!.timestamp;
    const expectedReward = Math.floor(
      (stakeDuration * USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL * REWARD_RATE_1) /
        (365 * 24 * 60 * 60) /
        1e12
    );

    const rewardGrowth =
      snapshots.at(-1)!.user2.total_reward -
      snapshots.at(-2)!.user2.total_reward;
    expect(rewardGrowth).to.within(expectedReward - 1, expectedReward + 1);
  });

  it("   User2 successfully accumulates new rewards while waiting for withdrawal", async () => {
    const expectedReward = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user2.user.publicKey,
      })
      .view();
    expect(expectedReward.toNumber()).to.be.greaterThan(0);
  });

  it("   Wait a little", async () => {
    // Wait for a few seconds to allow rewards to accumulate
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  it(`- User3 requests withdrawal [total: ${USER3_STAKE_AMOUNT} | staked: 0]`, async () => {
    const expectedReward = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .view();
    const tx = await program.methods
      .requestWithdrawal()
      .accounts({
        user: user3.user.publicKey,
      })
      .signers([user3.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawalRequested");
    expect(events[0].data.user).to.deep.eq(user3.user.publicKey);
    expect(events[0].data.addedTokenAmount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalTokenAmount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.addedRewardAmount.toNumber()).to.be.gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.totalRewardAmount.toNumber()).to.be.gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.withdrawalRequestTime).to.be.greaterThan(
      rewardStartedAt
    );
    user3FirstRequestRewards = events[0].data.addedRewardAmount.toNumber();
    user3FirstRequestTimestamp = events[0].data.withdrawalRequestTime;

    const userInfoPDA = getUserInfoPDA(program.programId, user3.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.stakedAt).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.be.greaterThan(rewardStartedAt);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).gte(
      expectedReward.toNumber()
    );
  });

  it(`+ User3 deposits some more tokens (100 tokens) [total: ${
    USER3_STAKE_AMOUNT * 2
  } | staked: ${USER3_STAKE_AMOUNT}]`, async () => {
    const tx = await program.methods
      .stake(new anchor.BN(USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL))
      .accounts({
        user: user3.user.publicKey,
        tokenMint: tokenMint,
      })
      .signers([user3.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("staked");
    expect(events[0].data.user).to.deep.eq(user3.user.publicKey);
    expect(events[0].data.amount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalUserStaked.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    const userInfoPDA = getUserInfoPDA(program.programId, user3.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.user.toString()).to.equal(user3.user.publicKey.toString());
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.equal(txinfo.blockTime);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.gt(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).gt(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      (USER2_STAKE_AMOUNT + USER3_STAKE_AMOUNT) * LAMPORTS_PER_SOL
    );

    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER3_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
  });
  it("   📝Snapshot user's positions (4)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });

  it(`- User2 withdraws. Receives only the amount that was in the queue. New rewards are still in the contract[total: ${USER2_STAKE_AMOUNT} | staked: ${USER2_STAKE_AMOUNT}]`, async () => {
    const user2TokenBalanceBefore = Number(
      (await getAccount(provider.connection, user2.ata)).amount
    );
    expect(user2TokenBalanceBefore).to.be.eq(0);

    const tx = await program.methods
      .withdraw()
      .accounts({
        user: user2.user.publicKey,
      })
      .signers([user2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawn");
    expect(events[0].data.user).to.deep.eq(user2.user.publicKey);
    expect(events[0].data.tokenAmount.toNumber()).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.rewardAmount.toNumber()).to.be.greaterThan(0);

    const userInfoPDA = getUserInfoPDA(program.programId, user2.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(userInfo.stakedAt).to.within(1, txinfo.blockTime - 1); // Not zero. Not the current time. Should not be updated on stake extension
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      (USER2_STAKE_AMOUNT + USER3_STAKE_AMOUNT) * LAMPORTS_PER_SOL
    );

    // Check the token balance of the userInfoPDA's ATA for tokenMint
    const userInfoTokenAccount = await anchor.utils.token.associatedAddress({
      mint: tokenMint,
      owner: userInfoPDA,
    });
    const userInfoTokenAccountInfo = await getAccount(
      provider.connection,
      userInfoTokenAccount
    );
    expect(Number(userInfoTokenAccountInfo.amount)).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    // Check the token balance of user2's ATA for tokenMint - should have received both stake and rewards
    const user2TokenBalanceAfter = Number(
      (await getAccount(provider.connection, user2.ata)).amount
    );
    expect(user2TokenBalanceAfter).to.eq(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL + user2FirstRequestRewards
    );
  });

  it("   Wait a few seconds", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  it("Admin2 sets reward rate to 0", async () => {
    const tx = await program.methods
      .configureRewardRatio(new anchor.BN(0))
      .accounts({
        administrator: admin2.user.publicKey,
      })
      .signers([admin2.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("rewardRatioConfigured");
    expect(events[0].data.administrator).to.deep.eq(admin2.user.publicKey);
    expect(
      events[0].data.newRewardRateYearlyPercentageNumerator.toNumber()
    ).to.eq(0);
    expect(
      events[0].data.newRewardRatePerSecondPerTokenNumerator.toNumber()
    ).to.eq(0);

    // Verify settings state updated
    const settingsPDA = getSettingsPDA(program.programId);
    const settings = await program.account.settings.fetch(settingsPDA);
    expect(settings.rewardRatePerSecondPerTokenNumerator.toNumber()).to.equal(
      0
    );
  });

  it("   Wait a few seconds", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  it("   📝Snapshot user's positions (5)", async () => {
    snapshots.push(
      await takeSnapshot(provider, program, eventParser, user1, user2, user3)
    );
  });

  it("   User2 earned twice as much as User3 since the last snapshot", async () => {
    const user2Rewards =
      snapshots.at(-1)!.user2.total_reward -
      snapshots.at(-2)!.user2.total_reward;
    const user3Rewards =
      snapshots.at(-1)!.user3.total_reward -
      snapshots.at(-2)!.user3.total_reward;
    // console.log(`User2 rewards: ${user2Rewards}, User3 rewards: ${user3Rewards}`);
    expect(user2Rewards).to.be.gt(0);
    expect(user2Rewards / 2).to.within(user3Rewards - 1, user3Rewards + 1);
  });
  it("   User2 rewards do not follow 8% rate, as it was set to 0", async () => {
    const stakeDuration =
      snapshots.at(-1)!.timestamp - snapshots.at(-2)!.timestamp;
    const rewardGrowth =
      snapshots.at(-1)!.user2.total_reward -
      snapshots.at(-2)!.user2.total_reward;
    const expectedReward = Math.floor(
      (stakeDuration * USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL * REWARD_RATE_1) /
        (365 * 24 * 60 * 60) /
        1e12
    );
    // console.log(`8% expected reward: ${expectedReward}, actual reward growth: ${rewardGrowth}`);
    expect(rewardGrowth).to.lt(expectedReward - 1);
    expect(rewardGrowth).to.gt(0);
  });

  it(`- User3 requests another withdrawal. Rewards are added. Timeout reset [total: ${
    USER3_STAKE_AMOUNT * 2
  } | staked: 0]`, async () => {
    const expectedReward = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .view();
    const tx = await program.methods
      .requestWithdrawal()
      .accounts({
        user: user3.user.publicKey,
      })
      .signers([user3.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawalRequested");
    expect(events[0].data.user).to.deep.eq(user3.user.publicKey);
    expect(events[0].data.addedTokenAmount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );
    expect(events[0].data.totalTokenAmount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(events[0].data.addedRewardAmount.toNumber()).to.be.gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.totalRewardAmount.toNumber()).to.be.gte(
      expectedReward.toNumber()
    );
    expect(events[0].data.withdrawalRequestTime).to.be.greaterThan(
      user3FirstRequestTimestamp
    );
    user3SecondRequestRewards = events[0].data.addedRewardAmount.toNumber();

    const userInfoPDA = getUserInfoPDA(program.programId, user3.user.publicKey);
    const userInfo = await program.account.userInfo.fetch(userInfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.be.greaterThan(rewardStartedAt);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(
      USER3_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).gte(
      user3FirstRequestRewards + expectedReward.toNumber()
    );
  });

  it("   Rewards are not accumulating anymore", async () => {
    const user2RewardsPrior = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user2.user.publicKey,
      })
      .view();
    const user3RewardsPrior = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .view();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const user2RewardsAfter = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user2.user.publicKey,
      })
      .view();
    const user3RewardsAfter = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .view();

    expect(user2RewardsAfter.toNumber()).to.equal(user2RewardsPrior.toNumber());
    expect(user3RewardsAfter.toNumber()).to.equal(user3RewardsPrior.toNumber());
  });

  it("- User3 chooses to withdraw without taking the rewards [total: 0 | staked: 0]", async () => {
    const user3InfoPDA = getUserInfoPDA(
      program.programId,
      user3.user.publicKey
    );
    const user3InfoBefore = await program.account.userInfo.fetch(user3InfoPDA);
    const forfeited_reward_amount =
      user3InfoBefore.withdrawalRequestRewardAmount.toNumber();

    expect(forfeited_reward_amount).to.be.greaterThan(0);

    const tx = await program.methods
      .withdrawAndForfeitRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .signers([user3.user])
      .rpc();

    const txinfo = await waitForTransaction(provider.connection, tx);
    const events = [...eventParser.parseLogs(txinfo.meta.logMessages)];
    expect(events.length).to.eq(1);
    expect(events[0].name).to.eq("withdrawnAndForfeitedRewards");
    expect(events[0].data.user).to.deep.eq(user3.user.publicKey);
    expect(events[0].data.tokenAmount.toNumber()).to.eq(
      USER3_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL
    );
    expect(events[0].data.forfeitedRewardAmount.toNumber()).to.eq(
      forfeited_reward_amount
    );

    // Verify user info is cleared
    const userInfo = await program.account.userInfo.fetch(user3InfoPDA);
    expect(userInfo.stakeAmount.toNumber()).to.equal(0);
    expect(userInfo.stakedAt).to.equal(0);
    expect(userInfo.capturedReward.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestTime).to.equal(0);
    expect(userInfo.withdrawalRequestAmount.toNumber()).to.equal(0);
    expect(userInfo.withdrawalRequestRewardAmount.toNumber()).to.equal(0);

    // Verify stats updated (total staked should remain the same since user still has staked amount)
    const statsPDA = getStatsPDA(program.programId);
    const stats = await program.account.stats.fetch(statsPDA);
    expect(stats.totalStaked.toNumber()).to.equal(
      USER2_STAKE_AMOUNT * LAMPORTS_PER_SOL
    );

    // Check token balances - user should have received their withdrawal request tokens
    // Verify no reward tokens were transferred to user3 (they were forfeited)
    // Since we're using single token design, user3 should only have received the staked tokens
    // The rewards were forfeited and remain in the protocol
    const user3TokenAccountInfo = await getAccount(
      provider.connection,
      user3.ata
    );
    expect(Number(user3TokenAccountInfo.amount)).to.equal(
      USER3_STAKE_AMOUNT * 2 * LAMPORTS_PER_SOL // Got back the tokens from withdrawal request
    );
  });
});
