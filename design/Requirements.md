# What

 - Staking contract written in Anchor.
 - Set of tests, verifying the functionality of the contract.

# Stake contract specifications

Allow users to stake specific SPL token. Users are rewarded for their participation with the same SPL token they staked.
The reward is returned to the users when they unstake their tokens.
There is a withdrawal delay after unstaking (5 days by default). The delay applies to both the stake and the rewards. When the withdrawal is requested, user should not receive any rewards for the tokens pending withdrawal.

Rewards are paid to users based on the amount of tokens they have staked and the time they have staked them.
Rewards are not shared between users, each user receives rewards based on their own stake.
The more tokens staked, the more rewards are paid out.


Users can do multiple stake operations.

Rewards ratio is configurable by administrator. Preferably, it is expressed as a percentage of the staked amount per year (APR).

Should be a function to see the current amount of accumulated rewards for a user.

Administrator periodically adds rewards to the contract, which should be used to pay out the rewards to users.

Should be a function to see how much unallocated rewards are available in the contract.

Should be a function to see how long these rewards will last at the current rate of payout.

Aministrator should be able to adjust the withdrawal delay period.
When withdrawal delay period is adjusted, it should come into affect immediately.