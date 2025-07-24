import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SplStakingLocked } from "../target/types/spl_staking_locked";
import { getMint } from "@solana/spl-token";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

async function main() {
  // Parse user address argument
  const argv = await yargs(hideBin(process.argv))
    .option("user", {
      alias: "u",
      type: "string",
      description: "User public key (base58)",
      demandOption: true,
      coerce: (arg) => {
        try {
          return new anchor.web3.PublicKey(arg);
        } catch (error) {
          throw new Error(`Invalid public key: ${arg}`);
        }
      },
    })
    .help().argv;

  // Configure Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .SplStakingLocked as Program<SplStakingLocked>;

  // Get user public key
  let user: anchor.web3.PublicKey;
  if (argv.user) {
    user = new anchor.web3.PublicKey(argv.user);
  } else {
    user = provider.wallet.publicKey;
  }
  console.log("👤 User: ", user.toString());

  // Derive PDAs
  const [settingsPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("settings")],
    program.programId
  );
  const [statsPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    program.programId
  );
  const [userInfoPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_info"), user.toBuffer()],
    program.programId
  );

  // Fetch mint decimals
  let mintInfo, decimals, decimalMultiplier;
  try {
    const settings = await program.account.settings.fetch(settingsPda);
    mintInfo = await getMint(provider.connection, settings.tokenMint);
    decimals = mintInfo.decimals;
    decimalMultiplier = Math.pow(10, decimals);
  } catch (error) {
    console.error("❌ Failed to fetch mint info or settings!");
    process.exit(1);
  }

  // Fetch user info
  try {
    console.log("\n📋 USER STATUS");
    console.log("-".repeat(30));
    const userInfo = await program.account.userInfo.fetch(userInfoPda);
    console.log(`👤 User: ${userInfo.user.toString()}`);
    console.log(
      `💰 Staked Amount: ${(
        Number(userInfo.stakeAmount) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `⏰ Staked At: ${
        userInfo.stakedAt
          ? new Date(userInfo.stakedAt * 1000).toLocaleString()
          : "Never"
      }`
    );
    console.log(
      `💸 Captured Reward: ${(
        Number(userInfo.capturedReward) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `💳 Withdrawal Request Amount: ${(
        Number(userInfo.withdrawalRequestAmount) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `💸 Withdrawal Request Reward: ${(
        Number(userInfo.withdrawalRequestRewardAmount) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log(
      `⏰ Withdrawal Request Time: ${
        userInfo.withdrawalRequestTime
          ? new Date(userInfo.withdrawalRequestTime * 1000).toLocaleString()
          : "None"
      }`
    );
  } catch (error) {
    console.error("❌ Failed to fetch user info! Are you staked?");
    process.exit(1);
  }

  // Call view_current_rewards
  try {
    const rewards = await program.methods
      .viewCurrentRewards()
      .accounts({
        user: user,
      })
      .view();
    console.log("-".repeat(30));
    console.log(
      `\n💰 viewCurrentRewards(user): ${(
        Number(rewards) / decimalMultiplier
      ).toLocaleString()} tokens`
    );
    console.log("-".repeat(30));
  } catch (error) {
    console.error("❌ Failed to fetch current rewards:", error.message);
  }

  console.log("\n✅ User status dump complete!");
}

main().catch((error) => {
  console.error("💥 Unexpected error:", error);
  process.exit(1);
});
