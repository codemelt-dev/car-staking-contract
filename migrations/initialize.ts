import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import { PublicKey } from "@solana/web3.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface InitializeArgs {
  token: string;
  "withdrawal-delay": number;
  "reward-rate": string;
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .usage("Usage: $0 --token <address> [options]")
    .option("token", {
      alias: "t",
      type: "string",
      description: "Token mint address",
      demandOption: true,
      requiresArg: true,
    })
    .option("withdrawal-delay", {
      alias: "w",
      type: "number",
      description: "Withdrawal delay in days",
      default: 5,
      requiresArg: true,
    })
    .option("reward-rate", {
      alias: "r",
      type: "string",
      description: "Reward rate with 1e12 precision",
      default: "80_000_000_000",
      requiresArg: true,
    })
    .example(
      "$0 --token 2TB758LUSDovyzFEZuHhj9dBCbk79qvhia2bHRyhKErN",
      "Initialize with default settings"
    )
    .example(
      "$0 -t 2TB758LUSDovyzFEZuHhj9dBCbk79qvhia2bHRyhKErN -w 7 -r 100_000_000_000",
      "Initialize with custom settings"
    )
    .check((argv) => {
      // Validate token address
      try {
        new PublicKey(argv.token);
      } catch (error) {
        throw new Error(`Invalid token mint address: ${argv.token}`);
      }

      // Validate withdrawal delay
      if (argv["withdrawal-delay"] < 1) {
        throw new Error(
          `Withdrawal delay must be at least 1 day, got: ${argv["withdrawal-delay"]}`
        );
      }

      // Validate reward rate
      const rewardRateStr = argv["reward-rate"].replace(/_/g, "");
      const rewardRate = parseInt(rewardRateStr);
      if (isNaN(rewardRate) || rewardRate < 0) {
        throw new Error(`Invalid reward rate: ${argv["reward-rate"]}`);
      }

      return true;
    })
    .help("h")
    .alias("h", "help")
    .version(false)
    .strict()
    .parseAsync()) as InitializeArgs;

  // Parse validated parameters
  const tokenMint = new PublicKey(argv.token);
  const withdrawalDays = argv["withdrawal-delay"];
  const rewardRateStr = argv["reward-rate"].replace(/_/g, "");
  const rewardRate = parseInt(rewardRateStr);

  // Display parameters
  console.log("🚀 SPL Staking Locked - Program Initialization");
  console.log("=".repeat(50));
  console.log("📝 Parameters:");
  console.log(`   Token Mint: ${tokenMint.toString()}`);
  console.log(`   Withdrawal Delay: ${withdrawalDays} days`);
  console.log(
    `   Reward Rate: ${rewardRate.toLocaleString()} (${rewardRate / 1e10}% APR)`
  );

  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  console.log(`\n🌐 Network: ${provider.connection.rpcEndpoint}`);
  console.log(`📋 Program ID: ${program.programId.toString()}`);
  console.log(`👤 Administrator: ${provider.wallet.publicKey.toString()}`);

  // Check if already initialized
  try {
    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );

    const existingSettings = await program.account.settings.fetch(
      settingsKeypair[0]
    );
    console.log("\n⚠️  Program appears to already be initialized!");
    console.log(
      `   Current administrator: ${existingSettings.administrator.toString()}`
    );
    console.log(
      `   Current token mint: ${existingSettings.tokenMint.toString()}`
    );

    console.log("❌ Initialization cancelled.");
    return;
  } catch (error) {
    // Settings account doesn't exist, which is expected for first initialization
    console.log("\n✅ Program not yet initialized. Proceeding...");
  }

  try {
    console.log("\n⏳ Sending initialization transaction...");

    const tx = await program.methods
      .initialize(new anchor.BN(withdrawalDays), new anchor.BN(rewardRate))
      .accounts({
        tokenMint: tokenMint,
      })
      .rpc();

    console.log("✅ Program initialized successfully!");
    console.log(
      `📋 Transaction: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );

    // Verify the initialization
    console.log("\n🔍 Verifying initialization...");
    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );

    const settings = await program.account.settings.fetch(settingsKeypair[0]);
    console.log("⚙️  Settings Account:");
    console.log(`   Administrator: ${settings.administrator.toString()}`);
    console.log(`   Token Mint: ${settings.tokenMint.toString()}`);
    console.log(
      `   Withdrawal Delay: ${settings.withdrawalDelaySeconds} seconds (${
        settings.withdrawalDelaySeconds / 86400
      } days)`
    );
    console.log(
      `   Reward Rate: ${settings.rewardRatePerSecondPerTokenNumerator.toString()}`
    );

    const statsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("stats")],
      program.programId
    );

    const stats = await program.account.stats.fetch(statsKeypair[0]);
    console.log("📊 Stats Account:");
    console.log(`   Total Staked: ${stats.totalStaked.toString()}`);
    console.log(
      `   Total Reward Provided: ${stats.totalRewardProvided.toString()}`
    );
    console.log(
      `   Last Update: ${new Date(stats.lastUpdateTime * 1000).toISOString()}`
    );

    console.log("\n🎉 Initialization complete!");
    console.log("📝 Next steps:");
    console.log("   • Add rewards: anchor run add-rewards");
    console.log("   • View status: anchor run status");
  } catch (error) {
    console.error("\n❌ Initialization failed:");
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
