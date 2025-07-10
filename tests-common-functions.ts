import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import * as splToken from "@solana/spl-token";

export async function airdrop(
  provider: anchor.Provider,
  user: web3.Keypair,
  balanceInSOLs: number
) {
  // Request airdrop
  const tx = await provider.connection.requestAirdrop(
    user.publicKey,
    web3.LAMPORTS_PER_SOL * balanceInSOLs
  );

  // Wait for confirmation
  const latestBlockHash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature: tx,
  });
}

export async function newUserWithSOL(
  provider: anchor.Provider,
  balanceInSOLs: number
) {
  let newUser = web3.Keypair.generate();

  await airdrop(provider, newUser, balanceInSOLs);

  return newUser;
}

export async function newUserWithSOLAndToken(
  provider: anchor.Provider,
  balanceInSOLs: number,
  tokenMint: web3.PublicKey,
  tokenOwner: web3.Keypair,
  tokenAmount: number
) {
  let user = web3.Keypair.generate();
  await airdrop(provider, user, balanceInSOLs);

  let ata = await splToken.createAssociatedTokenAccount(
    provider.connection,
    tokenOwner,
    tokenMint,
    user.publicKey
  );

  let ret = await splToken.mintTo(
    provider.connection,
    tokenOwner,
    tokenMint,
    ata,
    tokenOwner,
    tokenAmount * web3.LAMPORTS_PER_SOL
  );

  return { user, ata };
}

export async function waitForTransaction(
  connection: anchor.web3.Connection,
  signature: string
): Promise<anchor.web3.VersionedTransactionResponse> {
  let txinfo: anchor.web3.VersionedTransactionResponse | null = null;
  while (!txinfo) {
    txinfo = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  }
  return txinfo;
}
