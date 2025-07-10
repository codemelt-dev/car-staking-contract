# Stake contract implementation notes

Name: spl-staking-locked
Actors: administrator, users

## Architecture
Masterchef's style accumulators for the rewards, but without splitting rewards between users.

Unlike traditional masterchef where the reward rate is divided among all stakers, each user receives the full reward rate based on their individual stake amount. This means:
- Global reward rate applies to all users equally (e.g., 10% APR)
- Each user earns: `user_stake_amount * reward_rate * time_staked`
- Users don't compete for a shared reward pool
- Total protocol liability grows with both the number of users and total staked amount

To track this data we will use two accumulators:

### 1. A. `reward_per_token_stored`
Tracking the amount of rewards paid for each token staked.
For each user we will track the snapshort of this accumulator at the time of their last stake or withdrawal request. `reward_per_token_paid`.

How it was used in masterchef:
```
In the masterchef it was called:
 - rewardsPerShare, when kept in the pool.
 - rewardDebt, when the snapshot was kept in the user info. This one is multiplied by the number of tokens staked by the user.

rewardsPerShare was updated:
  - On each deposit
  - On each withdrawal
  - Any time anyone called this function directly

This is the main way of adding rewards to the pool.
```

In our case, there is a difference. We do not divide rewards between users. So, when the new deposits are made, or when the user unstakes, the rewards rate is not changed, and it may look, like we do not need to update it. But, it is not exactly true. We still need to update the accumulator, when the new deposits happen, so that we can set the rewardDebt for the user correctly.
Also we need to update it, when the user requests withdrawal, so that we can calculate the rewards correctly at the time of withdrawal.


When the user extends his position, we need to 'claim' rewards and reset the rewardsDebt to the current value of the accumulator.
Unlike masterchef, we do not return rewards until the final withdrawal. We should 'claim' into a separate variable. Will be released during the withdrawal.

### 2. B. `total_reward_promised`
We should track the amount of shares earning rewards at any given time in a variable. `Stats -> total_staked`

Additionally, we need to track the total amount of rewards promised to the users before the last rewards rate or total_staked amount change. `Stats -> total_rewards_promised`

So, at any point in time we can calculate the total amount of rewards promised to the users as:

```
total_rewards_promised_right_now = total_staked_tokens * reward_rate * time_since_last_change + total_rewards_promised_before_last_change
```

We need to keep track of the total rewards deposited in the contract as well.
Using this and `total_rewards_promised`, we can calculate the health of the contract and the amount of time it can continue paying rewards at the current rate.


### Other notes
For calculations use u64 with the scaling factor of 10^12.

Time units are in seconds.

Keep user's deposited funds in personal accounts. Would not allow one user to withdraw another user's funds, even if there are errors in the mathematics of the contract.

## Contract settings

### Static settings
Hardcoded, or set during initialization. Cannot be changed later.
 - Address of the token to be staked (same token used for rewards)

### Dynamic settings
Can be changed by the administrator at any time.
 - Withdrawal delay
   period (in days)
 - Reward ratio
   per unit of time per staked token
 - Administrator address
   Can be handed over. Handing over should be two step process, where the new administrator address is set first, and then the new administrator address confirms the change. Makes sure, that the ownership is not lost by mistake.

## User functions:
- Stake tokens
  Users can stake any amount of tokens they want.
  Can be called multiple times, each time adding to the total staked amount.
  Should correctly calculate amount of the rewards owed to the user.

- Request withdrawal (Unstake)
  Users can request to withdraw their staked tokens and rewards.
  This will put the amount on hold for the withdrawal delay period.

  No need to have support for multiple withdrawal requests per user.
  Support only one withdrawal request per user.
  Requesting a new withdrawal updates the previous one, if any.
  Not really likely, as we only support full withdrawal of all staked tokens and rewards. Someone would have to request withdrawal, stake some more and then request withdrawal again.

- Withdraw tokens and rewards
  Make sure the withdrawal delay period has passed.
  Return the user the staked tokens and rewards, which were in the queue for withdrawal.
  If not enough tokens are available in the contract for rewards, the withdrawal should fail.

- Withdraw tokens forfieting rewards
  Users still have to request withdrawal and wait for the withdrawal delay period.
  In this case, they forfeit all rewards they have accumulated.
  This may become useful in case of emergency, when the user needs to withdraw funds, but there are not enough tokens in the contract to pay out the rewards.

## Administrative functions:

 - Add rewards
   Function allowing administrator to fund the contract with tokens for rewards.

 - Configure reward ratio
   Function allowing administrator to configure the reward ratio per unit of time.
   Could be a number of tokens per month per staked token, or a percentage of the staked amount per month. Or per year, to represent 'APR'.

 - Configure withdrawal delay
   Function to adjust the withdrawal delay period.

 - Initiate ownership transfer
   Function allowing administrator to initiate the ownership transfer to a new address.
   The new address should confirm the change.

## Other functions:
 - Finalize ownership transfer
   Function allowing the new administrator to confirm the ownership transfer.
   This should be called after the new address is set by the previous administrator.

 - View current rewards per user
   Function allowing users to see the current amount of accumulated rewards for their stake.
