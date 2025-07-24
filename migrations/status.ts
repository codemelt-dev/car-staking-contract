import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import { getMint } from "@solana/spl-token";

async function main() {
  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  console.log("📊 SPL Staking Locked - Account Status");
  console.log("=".repeat(50));
  console.log(`🌐 Network: ${provider.connection.rpcEndpoint}`);
  console.log(`📋 Program ID: ${program.programId.toString()}`);

  let mintInfo;
  let decimals;
  let decimalMultiplier;

  try {
    // Fetch Settings account
    console.log("\n⚙️  SETTINGS ACCOUNT");
    console.log("-".repeat(30));

    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );
    console.log(`📍 Settings PDA: ${settingsKeypair[0].toString()}`);

    const settings = await program.account.settings.fetch(settingsKeypair[0]);

    console.log(`👤 Administrator: ${settings.administrator.toString()}`);
    console.log(
      `🔄 Pending Administrator: ${
        settings.pendingAdministrator
          ? settings.pendingAdministrator.toString()
          : "None"
      }`
    );
    console.log(`🏦 Token Mint: ${settings.tokenMint.toString()}`);
    console.log(
      `⏰ Withdrawal Delay: ${settings.withdrawalDelaySeconds} seconds (${
        settings.withdrawalDelaySeconds / 86400
      } days)`
    );
    console.log(
      `💰 Reward Rate (per second per token): ${settings.rewardRatePerSecondPerTokenNumerator.toString()}`
    );

    // Calculate and display APR
    const yearlyRate =
      Number(settings.rewardRatePerSecondPerTokenNumerator) *
      365 *
      24 *
      60 *
      60;
    const aprPercentage = yearlyRate / 1e10;
    console.log(`📈 Current APR: ${aprPercentage.toFixed(2)}%`);

    // Store mint info for later
    mintInfo = await getMint(provider.connection, settings.tokenMint);
    decimals = mintInfo.decimals;
    decimalMultiplier = Math.pow(10, decimals);
  } catch (error) {
    console.error("❌ Failed to fetch Settings account!");
    console.error("   Is the program initialized?");
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }

  try {
    // Fetch Stats account
    console.log("\n📊 STATS ACCOUNT");
    console.log("-".repeat(30));

    const statsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stats")],
      program.programId
    );
    console.log(`📍 Stats PDA: ${statsKeypair[0].toString()}`);

    const stats = await program.account.stats.fetch(statsKeypair[0]);

    console.log(
      `🔢 Reward Per Token Stored: ${stats.rewardPerTokenStoredNumerator.toString()}`
    );
    console.log(
      `⏰ Last Update Time: ${new Date(
        stats.lastUpdateTime * 1000
      ).toLocaleString()}`
    );
    console.log(
      `🥩 Total Staked: ${(
        Number(stats.totalStaked) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `💸 Total Reward Promised: ${(
        Number(stats.totalRewardPromised) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `💰 Total Reward Provided: ${(
        Number(stats.totalRewardProvided) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    const secondsElapsed =
      Math.floor(Date.now() / 1000) - Number(stats.lastUpdateTime);
    const daysElapsed = secondsElapsed / (24 * 60 * 60);
    console.log(
      `💤 Unallocated Rewards Based on Storage (${secondsElapsed} seconds (${daysElapsed.toFixed(
        1
      )} days) old): ${(
        (Number(stats.totalRewardProvided) -
          Number(stats.totalRewardPromised)) /
        decimalMultiplier
      ).toLocaleString()} tokens`
    );
  } catch (error) {
    console.error("❌ Failed to fetch Stats account!");
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }

  try {
    // Fetch Protocol Token Account balance
    console.log("\n🏦 PROTOCOL TOKEN ACCOUNT");
    console.log("-".repeat(30));

    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );
    const protocolTokenAccount = await anchor.utils.token.associatedAddress({
      mint: mintInfo.address,
      owner: settingsKeypair[0],
    });

    console.log(
      `📍 Protocol Token Account: ${protocolTokenAccount.toString()}`
    );

    const accountInfo = await provider.connection.getTokenAccountBalance(
      protocolTokenAccount
    );
    const balance = Number(accountInfo.value.amount) / decimalMultiplier;

    console.log(`💰 Token Balance: ${balance.toLocaleString()} tokens`);
  } catch (error) {
    console.error("❌ Failed to fetch Protocol Token Account balance!");
    console.error(`   Error: ${error.message}`);
  }

  try {
    // Try to get protocol health view functions
    console.log("\n🔬 PROTOCOL HEALTH");
    console.log("-".repeat(30));

    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );
    const statsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stats")],
      program.programId
    );

    try {
      const unallocatedRewards = await program.methods
        .viewUnallocatedRewards()
        .view();

      console.log(
        `💰 Unallocated Rewards (view): ${(
          Number(unallocatedRewards) / decimalMultiplier
        ).toLocaleString()} tokens`
      );
    } catch (error) {
      console.log(`❌ Could not fetch unallocated rewards: ${error.message}`);
    }

    try {
      const rewardRunway = await program.methods.viewRewardRunway().view();

      const runwayBN = new anchor.BN(rewardRunway.toString());
      if (runwayBN.eq(new anchor.BN("18446744073709551615"))) {
        console.log(`⏰ Reward Runway: ∞ (infinite - no active staking)`);
      } else {
        const runwaySeconds = Number(rewardRunway);
        const runwayDays = runwaySeconds / (24 * 60 * 60);
        console.log(
          `⏰ Reward Runway: ${runwaySeconds.toLocaleString()} seconds (${runwayDays.toFixed(
            1
          )} days)`
        );
      }
    } catch (error) {
      console.log(`❌ Could not fetch reward runway: ${error.message}`);
    }
  } catch (error) {
    console.log(
      `⚠️  Could not fetch protocol health metrics: ${error.message}`
    );
  }

  console.log("\n✅ Account dump complete!");
}

main().catch((error) => {
  console.error("💥 Unexpected error:", error);
  process.exit(1);
});
