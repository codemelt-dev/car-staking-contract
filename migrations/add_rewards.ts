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

interface AddRewardsArgs {
  amount: string;
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .usage("Usage: $0 --amount <amount> [options]")
    .option("amount", {
      alias: "a",
      type: "string",
      description: "Amount of tokens to add as rewards (supports underscores)",
      demandOption: true,
      requiresArg: true,
    })
    .example("$0 --amount 1000", "Add 1000 tokens as rewards")
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
    .parseAsync()) as AddRewardsArgs;

  // Parse validated parameters
  const amountStr = argv.amount.replace(/_/g, "");
  const amount = parseFloat(amountStr);

  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  console.log("💰 SPL Staking Locked - Add Rewards");
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
  console.log(`👤 Administrator: ${provider.wallet.publicKey.toString()}`);

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

  // Verify we're the administrator
  if (!settings.administrator.equals(provider.wallet.publicKey)) {
    console.error("❌ You are not the administrator of this program!");
    console.error(`   Current admin: ${settings.administrator.toString()}`);
    console.error(`   Your wallet: ${provider.wallet.publicKey.toString()}`);
    process.exit(1);
  }

  // Get admin's token account
  const adminTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    provider.wallet.publicKey
  );

  // Check admin's token balance
  let adminBalance;
  try {
    const accountInfo = await getAccount(
      provider.connection,
      adminTokenAccount
    );
    adminBalance = Number(accountInfo.amount);
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
      adminBalance / decimalMultiplier
    ).toLocaleString()} tokens`
  );
  console.log(`   Amount to Add: ${amount.toLocaleString()} tokens`);
  console.log(
    `   Remaining After: ${(
      (adminBalance - amountLamports) /
      decimalMultiplier
    ).toLocaleString()} tokens`
  );

  // Check if user has enough balance
  if (adminBalance < amountLamports) {
    console.error("\n❌ Insufficient balance!");
    console.error(`   Need: ${amount.toLocaleString()} tokens`);
    console.error(
      `   Have: ${(adminBalance / decimalMultiplier).toLocaleString()} tokens`
    );
    console.error(
      `   Missing: ${(
        (amountLamports - adminBalance) /
        decimalMultiplier
      ).toLocaleString()} tokens`
    );
    process.exit(1);
  }

  // Get current protocol health
  console.log("\n🔬 Protocol Health:");

  let unallocatedRewardsBefore = 0;
  let rewardRunwayBefore = 0;

  try {
    unallocatedRewardsBefore = await program.methods
      .viewUnallocatedRewards()
      .accounts({
        settings: settingsKeypair[0],
        stats: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("stats")],
          program.programId
        )[0],
      })
      .view();

    rewardRunwayBefore = await program.methods
      .viewRewardRunway()
      .accounts({
        settings: settingsKeypair[0],
        stats: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("stats")],
          program.programId
        )[0],
      })
      .view();

    console.log(
      `   Unallocated Rewards: ${(
        Number(unallocatedRewardsBefore) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `   Reward Runway: ${rewardRunwayBefore} seconds (${(
        rewardRunwayBefore / 86400
      ).toFixed(2)} days)`
    );
  } catch (error) {
    console.error(
      "❌ Failed to fetch protocol health (unallocated rewards/runway)."
    );
    process.exit(1);
  }

  try {
    console.log("\n⏳ Sending add rewards transaction...");

    const tx = await program.methods
      .addRewards(new anchor.BN(amountLamports))
      .accounts({
        administrator: provider.wallet.publicKey,
      })
      .rpc();

    console.log("✅ Rewards added successfully!");
    console.log(
      `📋 Transaction: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );

    // Verify the addition
    console.log("\n🔍 Verifying reward addition...");

    const unallocatedRewardsAfter = await program.methods
      .viewUnallocatedRewards()
      .accounts({
        settings: settingsKeypair[0],
        stats: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("stats")],
          program.programId
        )[0],
      })
      .view();

    const rewardRunwayAfter = await program.methods
      .viewRewardRunway()
      .accounts({
        settings: settingsKeypair[0],
        stats: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("stats")],
          program.programId
        )[0],
      })
      .view();

    console.log(
      `   Unallocated Rewards (after): ${(
        Number(unallocatedRewardsAfter) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `   Reward Runway (after): ${rewardRunwayAfter} seconds (${(
        rewardRunwayAfter / 86400
      ).toFixed(2)} days)`
    );

    // Check updated balance
    const newAccountInfo = await getAccount(
      provider.connection,
      adminTokenAccount
    );
    const newBalance = Number(newAccountInfo.amount);
    console.log(
      `   Your New Balance: ${(
        newBalance / decimalMultiplier
      ).toLocaleString()} tokens`
    );

    console.log("\n🎉 Rewards addition complete!");
  } catch (error) {
    console.error("\n❌ Adding rewards failed:");
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
