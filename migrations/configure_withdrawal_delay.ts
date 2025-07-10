import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface ConfigureWithdrawalDelayArgs {
  days: number;
}

async function main() {
  const argv = (await yargs(hideBin(process.argv))
    .usage("Usage: $0 --days <number>")
    .option("days", {
      alias: "d",
      type: "number",
      description: "Withdrawal delay in days (must be whole number >= 0)",
      demandOption: true,
      requiresArg: true,
    })
    .example("$0 --days 5", "Set withdrawal delay to 5 days")
    .example("$0 -d 0", "Set withdrawal delay to 0 days (instant withdrawal)")
    .example("$0 --days 7", "Set withdrawal delay to 7 days")
    .check((argv) => {
      // Validate days parameter
      if (!Number.isInteger(argv.days)) {
        throw new Error(`Days must be a whole number, got: ${argv.days}`);
      }

      if (argv.days < 0) {
        throw new Error(`Days must be non-negative, got: ${argv.days}`);
      }

      if (argv.days > 31) {
        throw new Error(`Days cannot exceed 31, got: ${argv.days}`);
      }

      return true;
    })
    .help("h")
    .alias("h", "help")
    .version(false)
    .strict()
    .parseAsync()) as ConfigureWithdrawalDelayArgs;

  const days = argv.days;
  const delaySeconds = days * 24 * 60 * 60;

  // Display parameters
  console.log("⏰ SPL Staking Locked - Configure Withdrawal Delay");
  console.log("=".repeat(50));
  console.log("📝 Parameters:");
  console.log(`   New Withdrawal Delay: ${days} days`);
  console.log(`   Delay in Seconds: ${delaySeconds} seconds`);

  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  console.log(`\n🌐 Network: ${provider.connection.rpcEndpoint}`);
  console.log(`📋 Program ID: ${program.programId.toString()}`);
  console.log(`👤 Administrator: ${provider.wallet.publicKey.toString()}`);

  // Check if program is initialized and verify administrator
  try {
    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );

    const existingSettings = await program.account.settings.fetch(
      settingsKeypair[0]
    );

    console.log("\n🔍 Current Settings:");
    console.log(
      `   Current Administrator: ${existingSettings.administrator.toString()}`
    );
    console.log(
      `   Current Withdrawal Delay: ${
        existingSettings.withdrawalDelaySeconds
      } seconds (${existingSettings.withdrawalDelaySeconds / 86400} days)`
    );
    console.log(`   Token Mint: ${existingSettings.tokenMint.toString()}`);

    // Verify we're the administrator
    if (!existingSettings.administrator.equals(provider.wallet.publicKey)) {
      console.error("\n❌ You are not the administrator of this program!");
      console.error(
        `   Current admin: ${existingSettings.administrator.toString()}`
      );
      console.error(`   Your wallet: ${provider.wallet.publicKey.toString()}`);
      process.exit(1);
    }

    // Check if the value is the same
    if (existingSettings.withdrawalDelaySeconds === delaySeconds) {
      console.log("\n⚠️  Withdrawal delay is already set to this value!");
      console.log("✅ No changes needed.");
      return;
    }
  } catch (error) {
    console.error(
      "\n❌ Failed to fetch program settings. Is the program initialized?"
    );
    console.error("   Run: anchor run initialize -- --token <TOKEN_MINT>");
    process.exit(1);
  }

  try {
    console.log("\n⏳ Sending withdrawal delay configuration transaction...");

    const tx = await program.methods
      .configureWithdrawalDelay(new anchor.BN(delaySeconds))
      .accounts({
        administrator: provider.wallet.publicKey,
      })
      .rpc();

    console.log("✅ Withdrawal delay configured successfully!");
    console.log(
      `📋 Transaction: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );

    // Verify the configuration
    console.log("\n🔍 Verifying configuration...");
    const settingsKeypair = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("settings")],
      program.programId
    );

    const updatedSettings = await program.account.settings.fetch(
      settingsKeypair[0]
    );
    console.log("⚙️  Updated Settings:");
    console.log(
      `   Administrator: ${updatedSettings.administrator.toString()}`
    );
    console.log(`   Token Mint: ${updatedSettings.tokenMint.toString()}`);
    console.log(
      `   New Withdrawal Delay: ${
        updatedSettings.withdrawalDelaySeconds
      } seconds (${updatedSettings.withdrawalDelaySeconds / 86400} days)`
    );

    console.log("\n🎉 Configuration complete!");
    console.log(
      "📝 The new withdrawal delay is now in effect for all future withdrawal requests."
    );
  } catch (error) {
    console.error("\n❌ Configuration failed:");
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
