# SPL Staking Documentation

## Functions

### Administrative Functions

#### `add_rewards`
Allows the administrator to add reward tokens to the protocol pool. These tokens will be distributed to users as staking rewards over time based on the configured reward rate.

```typescript
await program.methods
  .addRewards(new anchor.BN(1000 * LAMPORTS_PER_SOL))
  .accounts({
    administrator: admin.publicKey,
  })
  .signers([admin])
  .rpc();
```

#### `configure_reward_ratio`
Sets the annual percentage rate for staking rewards. The argument is a numerator with 1e12 precision, where 1e12 equals 100% APR.  
Example values:  
8% APR = 80_000_000_000  
10% APR = 100_000_000_000  
100% APR = 1_000_000_000_000

```typescript
await program.methods
  .configureRewardRatio(new anchor.BN(80_000_000_000)) // 8% annual rate
  .accounts({
    administrator: admin.publicKey,
  })
  .signers([admin])
  .rpc();
```

#### `configure_withdrawal_delay`
Modifies the time delay required between requesting a withdrawal and being able to execute it. Effective immediately. Default value is 5. Maximum allowed delay is 31 days.
Can be set to 0, which means no delay is required. In this case, users can withdraw immediately after requesting withdrawal.

```typescript
await program.methods
  .configureWithdrawalDelay(new anchor.BN(5)) // 5 days
  .accounts({
    administrator: admin.publicKey,
  })
  .signers([admin])
  .rpc();
```

#### `initiate_ownership_transfer`
Begins the process of transferring administrative control to a new address. The new administrator must call `finalize_ownership_transfer` to complete the process.

```typescript
await program.methods
  .initiateOwnershipTransfer(newAdmin.publicKey)
  .accounts({
    administrator: admin.publicKey,
  })
  .signers([admin])
  .rpc();
```

#### `finalize_ownership_transfer`
Completes the ownership transfer process initiated by the current administrator. Only the designated new administrator can call this function.

```typescript
await program.methods
  .finalizeOwnershipTransfer()
  .accounts({
    newAdministrator: newAdmin.publicKey,
  })
  .signers([newAdmin])
  .rpc();
```

### User Functions

#### `stake`
Deposits tokens into the staking pool to earn rewards. The only parameter is the amount of tokens to stake.

```typescript
await program.methods
  .stake(new anchor.BN(100 * LAMPORTS_PER_SOL))
  .accounts({
    user: user.publicKey,
    tokenMint: tokenMint,
  })
  .signers([user])
  .rpc();
```

#### `request_withdrawal`
Initiates a withdrawal request for all staked tokens and accumulated rewards. Tokens enter a withdrawal queue with a time delay before they can be claimed. No partial withdrawals is supported; users must withdraw all their staked tokens at once. Users do not earn rewards for the funds in the withdrawal queue.

```typescript
await program.methods
  .requestWithdrawal()
  .accounts({
    user: user.publicKey,
  })
  .signers([user])
  .rpc();
```

#### `withdraw`
Executes a withdrawal after the required delay period has passed. Transfers both the original staked tokens and earned rewards to the user's account.

```typescript
await program.methods
  .withdraw()
  .accounts({
    user: user.publicKey,
  })
  .signers([user])
  .rpc();
```

#### `withdraw_and_forfeit_rewards`
Emergency withdrawal function that allows users to retrieve their staked tokens while forfeiting all accumulated rewards. Still respects the withdrawal delay period. Only meant to be used, if there are not enough rewards in the pool and the user wants to exit without waiting for rewards to be supplied.

```typescript
await program.methods
  .withdrawAndForfeitRewards()
  .accounts({
    user: user.publicKey,
  })
  .signers([user])
  .rpc();
```

### View Functions

#### `view_current_rewards`
Returns the total amount of rewards accumulated by a user.

```typescript
const totalRewards = await program.methods
  .viewCurrentRewards()
  .accounts({
    user: user.publicKey,
  })
  .view();
```

#### `view_unallocated_rewards`
Provides a way to estimate the health of the protocol. Shows the difference between rewards provided by administrators and rewards promised to users. Negative values indicate insufficient funds for promised rewards.
Protocol will continue to run, even if rewards run out. This metric shows that not everyone will be able to withdraw their rewards.

```typescript
const unallocatedRewards = await program.methods
  .viewUnallocatedRewards()
  .view();
```

#### `view_reward_runway`
Estimates how long the current reward pool will last at the current consumption rate. Returns the number of seconds until rewards are exhausted.

```typescript
const runwaySeconds = await program.methods
  .viewRewardRunway()
  .view();
```

## Storage

### Settings
Global configuration parameters for the staking protocol. Contains administrative settings and reward calculation parameters.

```rust
pub struct Settings {
    pub administrator: Pubkey,
    pub pending_administrator: Option<Pubkey>,
    pub token_mint: Pubkey,
    pub withdrawal_delay_seconds: u32,
    pub reward_rate_per_second_per_token_numerator: u64,
}
```

- `administrator` - Current protocol administrator public key
- `pending_administrator` - Administrator pending ownership transfer
- `token_mint` - SPL token mint for staking and rewards
- `withdrawal_delay_seconds` - Required delay before withdrawal execution
- `reward_rate_per_second_per_token_numerator` - Reward rate. Per second, per token, represented as a numerator with 1e12 precision.

Requesting the object from javascript:

```typescript
export function getSettingsPDA(programId: web3.PublicKey) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("settings")],
    programId
  )[0];
}


const settingsPDA = getSettingsPDA(program.programId);
const settings = await program.account.settings.fetch(settingsPDA);
```

### Stats
Protocol-wide statistics and accumulator values. Tracks global state for reward calculations and fund management.

```rust
pub struct Stats {
    pub reward_per_token_stored_numerator: u64,
    pub last_update_time: u32,
    pub total_staked: u64,
    pub total_reward_promised: u64,
    pub total_reward_provided: u64,
}
```

- `reward_per_token_stored_numerator` - Accumulator for rewards earned per token. 
- `last_update_time` - Timestamp of last accumulators update
- `total_staked` - Total tokens currently staked across all users
- `total_reward_promised` - Accumulator reflecting the total rewards promised to users at the moment of last accumulators update
- `total_reward_provided` - Total rewards deposited by administrators

Requesting the object from javascript:

```typescript
export function getStatsPDA(programId: web3.PublicKey) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    programId
  )[0];
}

const statsPDA = getStatsPDA(program.programId);
const stats = await program.account.stats.fetch(statsPDA);
```

### UserInfo
Individual user account data for staking positions and withdrawal requests. Each user has one account storing their complete staking state.

```rust
pub struct UserInfo {
    pub user: Pubkey,
    pub stake_amount: u64,
    pub staked_at: u32,
    pub reward_per_token_paid_numerator: u64,
    pub captured_reward: u64,
    pub withdrawal_request_time: u32,
    pub withdrawal_request_amount: u64,
    pub withdrawal_request_reward_amount: u64,
}
```

- `user` - User's public key identifier
- `stake_amount` - User's staked token amount
- `staked_at` - Timestamp when the user first staked tokens. Not changed on staking extra. Reset on withdrawal request.
- `reward_per_token_paid_numerator` - User's reward accumulator snapshot
- `captured_reward` - Rewards already calculated and captured
- `withdrawal_request_time` - Timestamp when withdrawal was requested
- `withdrawal_request_amount` - Tokens pending withdrawal
- `withdrawal_request_reward_amount` - Rewards pending withdrawal


Requesting the object from javascript:

```typescript
function getUserInfoPDA(
  programId: web3.PublicKey,
  user: web3.PublicKey
) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user_info"), user.toBuffer()],
    programId
  )[0];
}

const userInfoPDA = getUserInfoPDA(program.programId, user.publicKey);
const userInfo = await program.account.userInfo.fetch(userInfoPDA);
```
