#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("E4ix78FMZ2HPjKvAyvRXJ4v5ipqZYkVUuswjuHkX7Q3v");

#[program]
pub mod spl_staking_locked {
    use super::*;

    // ===========================================
    // ============ ADMIN INSTRUCTIONS ==========
    // ===========================================

    pub fn initialize(
        ctx: Context<InitializeAccounts>,
        withdrawal_delay_days: u64,
        reward_rate_yearly_percentage_numerator: u64, // e.g., 80_000_000_000 for 8%
    ) -> Result<()> {
        let administrator = &ctx.accounts.administrator;
        let settings = &mut ctx.accounts.settings;
        let stats = &mut ctx.accounts.stats;
        let token_mint = &ctx.accounts.token_mint;
        let _system_program = &ctx.accounts.system_program;

        // Convert yearly percentage to per-second per-token rate
        let reward_rate_per_second_per_token_numerator =
            reward_rate_yearly_percentage_numerator / SECONDS_PER_YEAR;

        settings.administrator = administrator.key();
        settings.token_mint = token_mint.key();
        settings.withdrawal_delay_seconds = (withdrawal_delay_days * SECONDS_PER_DAY) as u32;
        settings.reward_rate_per_second_per_token_numerator =
            reward_rate_per_second_per_token_numerator;
        settings.pending_administrator = None;

        stats.reward_per_token_stored_numerator = 0;
        stats.last_update_time = Clock::get()?.unix_timestamp as u32;
        stats.total_staked = 0;
        stats.total_reward_promised = 0;
        stats.total_reward_provided = 0;

        let event = Initialized {
            administrator: administrator.key(),
            token_mint: token_mint.key(),
            withdrawal_delay_seconds: settings.withdrawal_delay_seconds,
            reward_rate_yearly_percentage_numerator,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn add_rewards(ctx: Context<AddRewardsAccounts>, amount: u64) -> Result<()> {
        let administrator = &ctx.accounts.administrator;
        let _settings = &ctx.accounts.settings;
        let stats = &mut ctx.accounts.stats;
        let admin_token_account = &ctx.accounts.admin_token_account;
        let protocol_token_account = &ctx.accounts.protocol_token_account;
        let token_program = &ctx.accounts.token_program;
        let _associated_token_program = &ctx.accounts.associated_token_program;
        let _system_program = &ctx.accounts.system_program;

        require!(amount > 0, StakingError::InvalidAmount);

        // Update total reward provided
        stats.total_reward_provided += amount;

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: admin_token_account.to_account_info(),
                    to: protocol_token_account.to_account_info(),
                    authority: administrator.to_account_info(),
                },
            ),
            amount,
        )?;

        let event = RewardsAdded {
            administrator: administrator.key(),
            amount,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn configure_reward_ratio(
        ctx: Context<ConfigureRewardRatioAccounts>,
        new_reward_rate_yearly_percentage_numerator: u64, // e.g., 80_000_000_000 for 8%
    ) -> Result<()> {
        let administrator = &ctx.accounts.administrator;
        let settings = &mut ctx.accounts.settings;
        let stats = &mut ctx.accounts.stats;

        // Update both accumulators before changing the rate
        update_accumulators(settings, stats)?;

        // Convert yearly percentage to per-second per-token rate
        let new_reward_rate_per_second_per_token_numerator =
            new_reward_rate_yearly_percentage_numerator / SECONDS_PER_YEAR;

        settings.reward_rate_per_second_per_token_numerator =
            new_reward_rate_per_second_per_token_numerator;

        let event = RewardRatioConfigured {
            administrator: administrator.key(),
            new_reward_rate_yearly_percentage_numerator,
            new_reward_rate_per_second_per_token_numerator,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn configure_withdrawal_delay(
        ctx: Context<ConfigureWithdrawalDelayAccounts>,
        new_withdrawal_delay_days: u64,
    ) -> Result<()> {
        let administrator = &ctx.accounts.administrator;
        let settings = &mut ctx.accounts.settings;

        require!(new_withdrawal_delay_days <= 31, StakingError::InvalidAmount);

        settings.withdrawal_delay_seconds = (new_withdrawal_delay_days * SECONDS_PER_DAY) as u32;

        let event = WithdrawalDelayConfigured {
            administrator: administrator.key(),
            new_withdrawal_delay_seconds: settings.withdrawal_delay_seconds,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn initiate_ownership_transfer(
        ctx: Context<InitiateOwnershipTransferAccounts>,
        new_administrator: Pubkey,
    ) -> Result<()> {
        let administrator = &ctx.accounts.administrator;
        let settings = &mut ctx.accounts.settings;

        settings.pending_administrator = Some(new_administrator);

        let event = OwnershipTransferInitiated {
            current_administrator: administrator.key(),
            new_administrator,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn finalize_ownership_transfer(
        ctx: Context<FinalizeOwnershipTransferAccounts>,
    ) -> Result<()> {
        let new_administrator = &ctx.accounts.new_administrator;
        let settings = &mut ctx.accounts.settings;

        require!(
            settings.pending_administrator == Some(new_administrator.key()),
            StakingError::UnauthorizedOwnershipTransfer
        );

        let old_administrator = settings.administrator;
        settings.administrator = new_administrator.key();
        settings.pending_administrator = None;

        let event = OwnershipTransferFinalized {
            old_administrator,
            new_administrator: settings.administrator,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    // ========================================
    // ========== USER INSTRUCTIONS ==========
    // ========================================

    pub fn stake(ctx: Context<StakeAccounts>, amount: u64) -> Result<()> {
        let user = &ctx.accounts.user;
        let settings = &ctx.accounts.settings;
        let stats = &mut ctx.accounts.stats;
        let user_info = &mut ctx.accounts.user_info;
        let user_token_account = &ctx.accounts.user_token_account;
        let user_info_token_account = &ctx.accounts.user_info_token_account;
        let _token_mint = &ctx.accounts.token_mint;
        let token_program = &ctx.accounts.token_program;
        let _associated_token_program = &ctx.accounts.associated_token_program;
        let _system_program = &ctx.accounts.system_program;

        require!(amount > 0, StakingError::InvalidAmount);

        if user_info.user == Pubkey::default() {
            // Initialize a new user
            user_info.user = user.key();

            // Update accumulators and set the reward paid. Ensures that the user is not getting any unfair rewards.
            update_accumulators(settings, stats)?;
            user_info.reward_per_token_paid_numerator = stats.reward_per_token_stored_numerator;
        } else {
            capture_rewards(settings, stats, user_info)?;
        }

        // Check existing stake amount to see if we need to reset the staked_at timestamp
        if user_info.stake_amount == 0 {
            user_info.staked_at = Clock::get()?.unix_timestamp as u32;
        }
        // If user already has stake_amount > 0, don't change staked_at (extending position)

        user_info.stake_amount += amount;
        stats.total_staked += amount;

        token::transfer(
            CpiContext::new(
                token_program.to_account_info(),
                Transfer {
                    from: user_token_account.to_account_info(),
                    to: user_info_token_account.to_account_info(),
                    authority: user.to_account_info(),
                },
            ),
            amount,
        )?;

        let event = Staked {
            user: user.key(),
            amount,
            total_user_staked: user_info.stake_amount,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn request_withdrawal(ctx: Context<RequestWithdrawalAccounts>) -> Result<()> {
        let user = &ctx.accounts.user;
        let settings = &ctx.accounts.settings;
        let stats = &mut ctx.accounts.stats;
        let user_info = &mut ctx.accounts.user_info;

        require!(user_info.stake_amount > 0, StakingError::NoStakeFound);

        capture_rewards(settings, stats, user_info)?;

        let original_stake_amount = user_info.stake_amount;
        let original_reward_amount = user_info.captured_reward;

        user_info.stake_amount = 0;
        stats.total_staked -= original_stake_amount;
        user_info.staked_at = 0;
        user_info.captured_reward = 0;

        user_info.withdrawal_request_time = Clock::get()?.unix_timestamp as u32;
        user_info.withdrawal_request_amount += original_stake_amount;
        user_info.withdrawal_request_reward_amount += original_reward_amount;

        let event = WithdrawalRequested {
            user: user.key(),
            added_token_amount: original_stake_amount,
            total_token_amount: user_info.withdrawal_request_amount,
            added_reward_amount: original_reward_amount,
            total_reward_amount: user_info.withdrawal_request_reward_amount,
            withdrawal_request_time: user_info.withdrawal_request_time,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn withdraw(ctx: Context<WithdrawAccounts>) -> Result<()> {
        let user = &ctx.accounts.user;
        let settings = &ctx.accounts.settings;
        let user_info = &mut ctx.accounts.user_info;
        let user_token_account = &ctx.accounts.user_token_account;
        let user_info_token_account = &ctx.accounts.user_info_token_account;
        let protocol_token_account = &ctx.accounts.protocol_token_account;
        let token_program = &ctx.accounts.token_program;
        let _associated_token_program = &ctx.accounts.associated_token_program;
        let _system_program = &ctx.accounts.system_program;

        require!(
            user_info.withdrawal_request_amount > 0
                || user_info.withdrawal_request_reward_amount > 0,
            StakingError::NoWithdrawalRequest
        );

        require!(
            Clock::get()?.unix_timestamp as u32
                >= user_info.withdrawal_request_time + settings.withdrawal_delay_seconds,
            StakingError::WithdrawalDelayNotMet
        );

        require!(
            protocol_token_account.amount >= user_info.withdrawal_request_reward_amount,
            StakingError::InsufficientRewards
        );

        let token_amount = user_info.withdrawal_request_amount;
        let reward_amount = user_info.withdrawal_request_reward_amount;

        // Transfer staked tokens back to user
        if token_amount > 0 {
            let signer: &[&[&[u8]]] = &[&[b"user_info", user.key.as_ref(), &[ctx.bumps.user_info]]];
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: user_info_token_account.to_account_info(),
                        to: user_token_account.to_account_info(),
                        authority: user_info.to_account_info(),
                    },
                    signer,
                ),
                token_amount,
            )?;
        }

        // Transfer reward tokens to SAME user account (same token type!)
        if reward_amount > 0 {
            let signer: &[&[&[u8]]] = &[&[b"settings", &[ctx.bumps.settings]]];
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: protocol_token_account.to_account_info(),
                        to: user_token_account.to_account_info(), // Same destination!
                        authority: settings.to_account_info(),
                    },
                    signer,
                ),
                reward_amount,
            )?;
        }

        user_info.withdrawal_request_reward_amount = 0;
        user_info.withdrawal_request_amount = 0;
        user_info.withdrawal_request_time = 0;

        let event = Withdrawn {
            user: user.key(),
            token_amount,
            reward_amount,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn withdraw_and_forfeit_rewards(
        ctx: Context<WithdrawAndForfeitRewardsAccounts>,
    ) -> Result<()> {
        let user = &ctx.accounts.user;
        let settings = &ctx.accounts.settings;
        let user_info = &mut ctx.accounts.user_info;
        let user_token_account = &ctx.accounts.user_token_account;
        let user_info_token_account = &ctx.accounts.user_info_token_account;
        let token_program = &ctx.accounts.token_program;

        require!(
            user_info.withdrawal_request_amount > 0,
            StakingError::NoWithdrawalRequest
        );

        require!(
            Clock::get()?.unix_timestamp as u32
                >= user_info.withdrawal_request_time + settings.withdrawal_delay_seconds,
            StakingError::WithdrawalDelayNotMet
        );

        let token_amount = user_info.withdrawal_request_amount;
        let forfeited_reward_amount = user_info.withdrawal_request_reward_amount;

        if token_amount > 0 {
            let signer: &[&[&[u8]]] = &[&[b"user_info", user.key.as_ref(), &[ctx.bumps.user_info]]];
            token::transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info(),
                    Transfer {
                        from: user_info_token_account.to_account_info(),
                        to: user_token_account.to_account_info(),
                        authority: user_info.to_account_info(),
                    },
                    signer,
                ),
                token_amount,
            )?;
        }

        user_info.withdrawal_request_reward_amount = 0;
        user_info.withdrawal_request_amount = 0;
        user_info.withdrawal_request_time = 0;

        let event = WithdrawnAndForfeitedRewards {
            user: user.key(),
            token_amount,
            forfeited_reward_amount,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(())
    }

    pub fn view_current_rewards(ctx: Context<ViewCurrentRewardsAccounts>) -> Result<u64> {
        let user = &ctx.accounts.user;
        let settings = &ctx.accounts.settings;
        let stats = &ctx.accounts.stats;
        let user_info = &ctx.accounts.user_info;

        // Calculate current reward_per_token_stored_numerator without updating state
        let time_elapsed = Clock::get()?.unix_timestamp as u32 - stats.last_update_time;
        let current_reward_per_token_stored_numerator = stats.reward_per_token_stored_numerator
            + settings.reward_rate_per_second_per_token_numerator * time_elapsed as u64;

        let uncaptured_reward = calculate_uncaptured_rewards(
            user_info.stake_amount,
            current_reward_per_token_stored_numerator,
            user_info.reward_per_token_paid_numerator,
        );
        let total_reward = user_info.captured_reward + uncaptured_reward;

        let event = CurrentRewardsViewed {
            user: user.key(),
            captured_reward: user_info.captured_reward,
            uncaptured_reward,
            total_reward,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(total_reward)
    }

    pub fn view_unallocated_rewards(ctx: Context<ViewUnallocatedRewardsAccounts>) -> Result<i128> {
        let settings = &ctx.accounts.settings;
        let stats = &ctx.accounts.stats;

        let unallocated_rewards = calculate_unallocated_rewards(settings, stats)?;

        let event = UnallocatedRewardsViewed {
            unallocated_rewards,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(unallocated_rewards)
    }

    pub fn view_reward_runway(ctx: Context<ViewRewardRunwayAccounts>) -> Result<u64> {
        let settings = &ctx.accounts.settings;
        let stats = &ctx.accounts.stats;

        // Calculate available rewards using helper function
        let unallocated_rewards = calculate_unallocated_rewards(settings, stats)?;
        let available_rewards = if unallocated_rewards > 0 {
            unallocated_rewards as u64
        } else {
            0 // No rewards available if we've promised more than provided
        };

        // Calculate current reward consumption rate per second
        let rewards_per_second = (stats.total_staked as u128
            * settings.reward_rate_per_second_per_token_numerator as u128)
            / PRECISION as u128;

        if rewards_per_second == 0 {
            return Ok(u64::MAX);
        }

        let runway_seconds = (available_rewards as u128) / rewards_per_second;
        let runway_seconds = if runway_seconds > u32::MAX as u128 {
            u64::MAX
        } else {
            runway_seconds as u64
        };

        let event = RewardRunwayViewed {
            available_rewards,
            runway_seconds,
        };
        msg!("{:?}", event);
        emit!(event);

        Ok(runway_seconds)
    }
}

// ===========================================
// ============ HELPER FUNCTIONS =============
// ===========================================

const PRECISION: u64 = 1_000_000_000_000; // 1e12 scaling factor
const SECONDS_PER_DAY: u64 = 24 * 60 * 60;
const SECONDS_PER_YEAR: u64 = 365 * SECONDS_PER_DAY; // 31,536,000 seconds

fn update_accumulators(settings: &Settings, stats: &mut Stats) -> Result<()> {
    let current_time = Clock::get()?.unix_timestamp as u32;
    if stats.total_staked == 0 {
        stats.last_update_time = current_time;
        return Ok(());
    }

    let time_elapsed = current_time - stats.last_update_time;

    if time_elapsed > 0 {
        // Simple: time_elapsed * rate_per_token_numerator = rewards_per_token_numerator to add
        let reward_increment_numerator =
            settings.reward_rate_per_second_per_token_numerator * time_elapsed as u64;

        stats.reward_per_token_stored_numerator += reward_increment_numerator;

        // Total rewards promised = total_staked * rewards_per_token_increment / PRECISION
        let total_new_reward = ((stats.total_staked as u128)
            * (reward_increment_numerator as u128))
            / (PRECISION as u128);
        stats.total_reward_promised += total_new_reward as u64;

        stats.last_update_time = current_time;
    }

    Ok(())
}

fn capture_rewards(settings: &Settings, stats: &mut Stats, user_info: &mut UserInfo) -> Result<()> {
    // Update accumulators first to get current state
    update_accumulators(settings, stats)?;

    user_info.captured_reward += calculate_uncaptured_rewards(
        user_info.stake_amount,
        stats.reward_per_token_stored_numerator,
        user_info.reward_per_token_paid_numerator,
    );

    // Reset user's snapshot to current accumulator value
    user_info.reward_per_token_paid_numerator = stats.reward_per_token_stored_numerator;

    Ok(())
}

fn calculate_uncaptured_rewards(
    stake_amount: u64,
    reward_per_token_stored_numerator: u64,
    reward_per_token_paid_numerator: u64,
) -> u64 {
    let reward_per_token_diff = reward_per_token_stored_numerator - reward_per_token_paid_numerator;

    let earned = ((stake_amount as u128) * (reward_per_token_diff as u128)) / (PRECISION as u128);

    earned as u64
}

fn calculate_total_promised_rewards(settings: &Settings, stats: &Stats) -> Result<u64> {
    let time_elapsed = Clock::get()?.unix_timestamp as u32 - stats.last_update_time;

    Ok(stats.total_reward_promised
        + (settings.reward_rate_per_second_per_token_numerator as u128
            * time_elapsed as u128
            * stats.total_staked as u128
            / PRECISION as u128) as u64)
}

fn calculate_unallocated_rewards(settings: &Settings, stats: &Stats) -> Result<i128> {
    let total_promised = calculate_total_promised_rewards(settings, stats)?;
    Ok(stats.total_reward_provided as i128 - total_promised as i128)
}

// ===========================================
// ============ ACCOUNT STRUCTURES ===========
// ===========================================

#[account]
#[derive(InitSpace)]
pub struct Settings {
    pub administrator: Pubkey,
    pub pending_administrator: Option<Pubkey>,
    pub token_mint: Pubkey,
    pub withdrawal_delay_seconds: u32,
    pub reward_rate_per_second_per_token_numerator: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Stats {
    pub reward_per_token_stored_numerator: u64,
    pub last_update_time: u32,
    pub total_staked: u64,
    pub total_reward_promised: u64,
    pub total_reward_provided: u64,
}

#[account]
#[derive(InitSpace)]
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

// ===========================================
// ============ ACCOUNT CONTEXTS =============
// ===========================================

#[derive(Accounts)]
pub struct InitializeAccounts<'info> {
    #[account(mut)]
    pub administrator: Signer<'info>,

    #[account(
        init,
        payer = administrator,
        space = 8 + Settings::INIT_SPACE,
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        init,
        payer = administrator,
        space = 8 + Stats::INIT_SPACE,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,

    #[account(
        init,
        payer = administrator,
        associated_token::mint = token_mint,
        associated_token::authority = settings,
    )]
    pub protocol_token_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddRewardsAccounts<'info> {
    #[account(mut)]
    pub administrator: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump,
        has_one = administrator
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = administrator,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = settings,
    )]
    pub protocol_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfigureRewardRatioAccounts<'info> {
    pub administrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"settings"],
        bump,
        has_one = administrator
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,
}

#[derive(Accounts)]
pub struct ConfigureWithdrawalDelayAccounts<'info> {
    pub administrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"settings"],
        bump,
        has_one = administrator
    )]
    pub settings: Account<'info, Settings>,
}

#[derive(Accounts)]
pub struct InitiateOwnershipTransferAccounts<'info> {
    pub administrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"settings"],
        bump,
        has_one = administrator
    )]
    pub settings: Account<'info, Settings>,
}

#[derive(Accounts)]
pub struct FinalizeOwnershipTransferAccounts<'info> {
    pub new_administrator: Signer<'info>,

    #[account(
        mut,
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,
}

#[derive(Accounts)]
pub struct StakeAccounts<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserInfo::INIT_SPACE,
        seeds = [b"user_info", user.key().as_ref()],
        bump
    )]
    pub user_info: Account<'info, UserInfo>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user_info,
    )]
    pub user_info_token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = token_mint.key() == settings.token_mint
    )]
    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestWithdrawalAccounts<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,

    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
    )]
    pub user_info: Account<'info, UserInfo>,
}

#[derive(Accounts)]
pub struct WithdrawAccounts<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
    )]
    pub user_info: Account<'info, UserInfo>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = user_info,
    )]
    pub user_info_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = settings,
    )]
    pub protocol_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawAndForfeitRewardsAccounts<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        mut,
        seeds = [b"user_info", user.key().as_ref()],
        bump,
    )]
    pub user_info: Account<'info, UserInfo>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = settings.token_mint,
        associated_token::authority = user_info,
    )]
    pub user_info_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ViewCurrentRewardsAccounts<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,

    #[account(
        seeds = [b"user_info", user.key().as_ref()],
        bump,
    )]
    pub user_info: Account<'info, UserInfo>,
}

#[derive(Accounts)]
pub struct ViewUnallocatedRewardsAccounts<'info> {
    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,
}

#[derive(Accounts)]
pub struct ViewRewardRunwayAccounts<'info> {
    #[account(
        seeds = [b"settings"],
        bump
    )]
    pub settings: Account<'info, Settings>,

    #[account(
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, Stats>,
}

// ===========================================
// ============ ERROR DEFINITIONS ============
// ===========================================

#[error_code]
pub enum StakingError {
    #[msg("Invalid amount provided")]
    InvalidAmount,
    #[msg("No stake found for user")]
    NoStakeFound,
    #[msg("No withdrawal request found")]
    NoWithdrawalRequest,
    #[msg("Withdrawal delay period has not been met")]
    WithdrawalDelayNotMet,
    #[msg("Insufficient rewards in pool")]
    InsufficientRewards,
    #[msg("Math overflow occurred")]
    MathOverflow,
    #[msg("Unauthorized ownership transfer")]
    UnauthorizedOwnershipTransfer,
}

// ===========================================
// ============ EVENT DEFINITIONS =============
// ===========================================

#[event]
#[derive(Debug)]
pub struct Initialized {
    pub administrator: Pubkey,
    pub token_mint: Pubkey,
    pub withdrawal_delay_seconds: u32,
    pub reward_rate_yearly_percentage_numerator: u64,
}

#[event]
#[derive(Debug)]
pub struct RewardsAdded {
    pub administrator: Pubkey,
    pub amount: u64,
}

#[event]
#[derive(Debug)]
pub struct RewardRatioConfigured {
    pub administrator: Pubkey,
    pub new_reward_rate_yearly_percentage_numerator: u64,
    pub new_reward_rate_per_second_per_token_numerator: u64,
}

#[event]
#[derive(Debug)]
pub struct WithdrawalDelayConfigured {
    pub administrator: Pubkey,
    pub new_withdrawal_delay_seconds: u32,
}

#[event]
#[derive(Debug)]
pub struct OwnershipTransferInitiated {
    pub current_administrator: Pubkey,
    pub new_administrator: Pubkey,
}

#[event]
#[derive(Debug)]
pub struct OwnershipTransferFinalized {
    pub old_administrator: Pubkey,
    pub new_administrator: Pubkey,
}

#[event]
#[derive(Debug)]
pub struct Staked {
    pub user: Pubkey,
    pub amount: u64,
    pub total_user_staked: u64,
}

#[event]
#[derive(Debug)]
pub struct WithdrawalRequested {
    pub user: Pubkey,
    pub added_token_amount: u64, // Stake tokens just added to withdrawal request
    pub total_token_amount: u64, // Total stake tokens in withdrawal request
    pub added_reward_amount: u64, // Rewards just added to withdrawal request
    pub total_reward_amount: u64, // Total rewards in withdrawal request
    pub withdrawal_request_time: u32,
}

#[event]
#[derive(Debug)]
pub struct Withdrawn {
    pub user: Pubkey,
    pub token_amount: u64,
    pub reward_amount: u64,
}

#[event]
#[derive(Debug)]
pub struct WithdrawnAndForfeitedRewards {
    pub user: Pubkey,
    pub token_amount: u64,
    pub forfeited_reward_amount: u64,
}

#[event]
#[derive(Debug)]
pub struct CurrentRewardsViewed {
    pub user: Pubkey,
    pub captured_reward: u64,
    pub uncaptured_reward: u64,
    pub total_reward: u64,
}

#[event]
#[derive(Debug)]
pub struct UnallocatedRewardsViewed {
    pub unallocated_rewards: i128,
}

#[event]
#[derive(Debug)]
pub struct RewardRunwayViewed {
    pub available_rewards: u64,
    pub runway_seconds: u64,
}
