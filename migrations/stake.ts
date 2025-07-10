import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import { PublicKey } from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface StakeArgs {
  amount: string;
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .usage("Usage: $0 --amount <amount> [options]")
    .option("amount", {
      alias: "a",
      type: "string",
      description: "Amount of tokens to stake (supports underscores)",
      demandOption: true,
      requiresArg: true,
    })
    .example("$0 --amount 100", "Stake 100 tokens")
    .check((argv) => {
      // Validate amount
      const amountStr = argv.amount.replace(/_/g, "");
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        throw new Error(`Invalid amount: ${argv.amount}`);
      }
      return true;
    })
    .help("h")
    .alias("h", "help")
    .version(false)
    .strict()
    .parseAsync()) as StakeArgs;

  // Parse validated parameters
  const amountStr = argv.amount.replace(/_/g, "");
  const amount = parseFloat(amountStr);

  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  console.log("🥩 SPL Staking Locked - Stake Tokens");
  console.log("=".repeat(40));

  // Get program settings to find token mint
  console.log("🔍 Fetching program settings...");
  const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("settings")],
    program.programId
  );

  let settings;
  try {
    settings = await program.account.settings.fetch(settingsKeypair[0]);
  } catch (error) {
    console.error(
      "❌ Failed to fetch program settings. Is the program initialized?"
    );
    console.error("   Run: anchor run initialize -- --token <TOKEN_MINT>");
    process.exit(1);
  }

  const tokenMint = settings.tokenMint;
  console.log(`📋 Program ID: ${program.programId.toString()}`);
  console.log(`🏦 Token Mint: ${tokenMint.toString()}`);
  console.log(`👤 User: ${provider.wallet.publicKey.toString()}`);

  // Get token mint info to check decimals
  console.log("🔍 Fetching token mint info...");
  let mintInfo;
  try {
    mintInfo = await getMint(provider.connection, tokenMint);
  } catch (error) {
    console.error("❌ Failed to fetch token mint info!");
    console.error("   Is the token mint valid?");
    process.exit(1);
  }

  const decimals = mintInfo.decimals;
  const decimalMultiplier = Math.pow(10, decimals);
  console.log(`🔢 Token Decimals: ${decimals}`);

  // Get user's token account
  const userTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    provider.wallet.publicKey
  );

  // Check user's token balance
  let userBalance;
  try {
    const accountInfo = await getAccount(provider.connection, userTokenAccount);
    userBalance = Number(accountInfo.amount);
  } catch (error) {
    console.error("❌ You don't have a token account for this mint!");
    console.error(
      `   Create one with: spl-token create-account ${tokenMint.toString()}`
    );
    process.exit(1);
  }

  // Convert amount to smallest units based on actual token decimals
  const amountLamports = Math.floor(amount * decimalMultiplier);

  console.log("\n📊 Balance Check:");
  console.log(
    `   Your Balance: ${(
      userBalance / decimalMultiplier
    ).toLocaleString()} tokens`
  );
  console.log(`   Amount to Stake: ${amount.toLocaleString()} tokens`);
  console.log(
    `   Remaining After: ${(
      (userBalance - amountLamports) /
      decimalMultiplier
    ).toLocaleString()} tokens`
  );

  // Check if user has enough balance
  if (userBalance < amountLamports) {
    console.error("\n❌ Insufficient balance!");
    console.error(`   Need: ${amount.toLocaleString()} tokens`);
    console.error(
      `   Have: ${(userBalance / decimalMultiplier).toLocaleString()} tokens`
    );
    console.error(
      `   Missing: ${(
        (amountLamports - userBalance) /
        decimalMultiplier
      ).toLocaleString()} tokens`
    );
    process.exit(1);
  }

  // Get current user info if exists
  const userInfoKeypair = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_info"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  let existingUserInfo = null;
  try {
    existingUserInfo = await program.account.userInfo.fetch(userInfoKeypair[0]);
    console.log("\n📈 Current Staking Info:");
    console.log(
      `   Currently Staked: ${(
        Number(existingUserInfo.stakeAmount) / decimalMultiplier
      ).toLocaleString()} tokens`
    );

    if (existingUserInfo.withdrawalRequestAmount.gt(new anchor.BN(0))) {
      console.log(
        `   Pending Withdrawal: ${(
          Number(existingUserInfo.withdrawalRequestAmount) / decimalMultiplier
        ).toLocaleString()} tokens`
      );
      const withdrawalTime = new Date(
        existingUserInfo.withdrawalRequestTime * 1000
      );
      const delayEnd = new Date(
        (existingUserInfo.withdrawalRequestTime +
          settings.withdrawalDelaySeconds) *
          1000
      );
      console.log(
        `   Withdrawal Requested: ${withdrawalTime.toLocaleString()}`
      );
      console.log(`   Available to Withdraw: ${delayEnd.toLocaleString()}`);
    }

    if (existingUserInfo.stakedAt > 0) {
      const stakedTime = new Date(existingUserInfo.stakedAt * 1000);
      console.log(`   Staking Started: ${stakedTime.toLocaleString()}`);
    }
  } catch (error) {
    console.log("\n📈 This will be your first stake in this program!");
  }

  // Get current protocol stats
  const statsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    program.programId
  );

  const statsBefore = await program.account.stats.fetch(statsKeypair[0]);
  console.log("\n📊 Protocol Stats:");
  console.log(
    `   Total Staked: ${(
      Number(statsBefore.totalStaked) / decimalMultiplier
    ).toLocaleString()} tokens`
  );
  const rewardRunwayBefore = await program.methods
    .viewRewardRunway()
    .accounts({
      settings: settingsKeypair[0],
      stats: statsKeypair[0],
    })
    .view();
  console.log(
    `   Reward Runway: ${rewardRunwayBefore} seconds (${(
      rewardRunwayBefore / 86400
    ).toFixed(2)} days)`
  );

  try {
    console.log("\n⏳ Sending stake transaction...");

    const tx = await program.methods
      .stake(new anchor.BN(amountLamports))
      .accounts({
        user: provider.wallet.publicKey,
        tokenMint: tokenMint,
      })
      .rpc();

    console.log("✅ Tokens staked successfully!");
    console.log(
      `📋 Transaction: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );

    // Verify the stake
    console.log("\n🔍 Verifying stake...");

    const userInfoAfter = await program.account.userInfo.fetch(
      userInfoKeypair[0]
    );
    const statsAfter = await program.account.stats.fetch(statsKeypair[0]);
    const rewardRunwayAfter = await program.methods
      .viewRewardRunway()
      .accounts({
        settings: settingsKeypair[0],
        stats: statsKeypair[0],
      })
      .view();

    console.log("📊 Updated Info:");
    console.log(
      `   Your Staked Amount: ${(
        Number(userInfoAfter.stakeAmount) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `   Total Staked: ${(
        Number(statsAfter.totalStaked) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `   Reward Runway: ${rewardRunwayAfter} seconds (${(
        rewardRunwayAfter / 86400
      ).toFixed(2)} days)`
    );

    if (userInfoAfter.stakedAt > 0) {
      const stakedTime = new Date(userInfoAfter.stakedAt * 1000);
      console.log(`   Staking Started: ${stakedTime.toLocaleString()}`);
    }

    // Check updated balance
    const newAccountInfo = await getAccount(
      provider.connection,
      userTokenAccount
    );
    const newBalance = Number(newAccountInfo.amount);
    console.log(
      `   Your New Token Balance: ${(
        newBalance / decimalMultiplier
      ).toLocaleString()} tokens`
    );

    console.log("\n🎉 Staking complete!");
    console.log("📝 You can now:");
    console.log("   • Check your rewards: anchor run view-rewards");
    console.log("   • Request withdrawal: anchor run request-withdrawal");
  } catch (error) {
    console.error("\n❌ Staking failed:");
    if (error instanceof anchor.AnchorError) {
      console.error(
        `   Anchor Error (${error.error.errorCode.code}): ${error.error.errorMessage}`
      );
    } else if (error.message) {
      console.error(`   Error: ${error.message}`);
    } else {
      console.error("   Unknown error:", error);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("💥 Unexpected error:", error);
  process.exit(1);
});
