import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import { SplStakingLocked } from "./target/types/spl_staking_locked";

// Type definitions for snapshot data
export type UserRewardSnapshot = {
  captured_reward: number;
  uncaptured_reward: number;
  total_reward: number;
};

export type Snapshot = {
  timestamp: number | null;
  user1: UserRewardSnapshot;
  user2: UserRewardSnapshot;
  user3: UserRewardSnapshot;
};

export function getSettingsPDA(programId: web3.PublicKey) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("settings")],
    programId
  )[0];
}

export function getStatsPDA(programId: web3.PublicKey) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    programId
  )[0];
}

export function getUserInfoPDA(
  programId: web3.PublicKey,
  user: web3.PublicKey
) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_info"), user.toBuffer()],
    programId
  )[0];
}

export async function takeSnapshot(
  provider: anchor.AnchorProvider,
  program: anchor.Program<SplStakingLocked>,
  eventParser: anchor.EventParser,
  user1: { user: web3.Keypair },
  user2: { user: web3.Keypair },
  user3: { user: web3.Keypair }
): Promise<Snapshot> {
  const transaction = new anchor.web3.Transaction();

  transaction.add(
    await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user1.user.publicKey,
      })
      .instruction()
  );

  transaction.add(
    await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user2.user.publicKey,
      })
      .instruction()
  );

  transaction.add(
    await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user3.user.publicKey,
      })
      .instruction()
  );

  const result = await provider.connection.simulateTransaction(transaction, [
    user1.user,
    user2.user,
    user3.user,
  ]);

  const timestamp = await provider.connection.getBlockTime(result.context.slot);
  const events = [...eventParser.parseLogs(result.value.logs)];

  // Helper function to extract user data with defaults
  const getUserSnapshot = (userKey: web3.PublicKey): UserRewardSnapshot => {
    const event = events.find(
      (e) => e.name === "currentRewardsViewed" && e.data.user.equals(userKey)
    );

    return event
      ? {
          captured_reward: event.data.capturedReward.toNumber(),
          uncaptured_reward: event.data.uncapturedReward.toNumber(),
          total_reward: event.data.totalReward.toNumber(),
        }
      : {
          captured_reward: 0,
          uncaptured_reward: 0,
          total_reward: 0,
        };
  };

  return {
    timestamp: timestamp,
    user1: getUserSnapshot(user1.user.publicKey),
    user2: getUserSnapshot(user2.user.publicKey),
    user3: getUserSnapshot(user3.user.publicKey),
  };
}
