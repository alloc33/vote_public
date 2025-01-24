use anchor_lang::prelude::*;

pub mod instructions;
pub use instructions::*;

// Declare the unique program ID that associates this Rust program with its deployed counterpart on
// Solana.
declare_id!("");

// Define a constant for the administrator's public key.
// This key is used to authenticate administrative actions within the governance contract.
pub const ADMIN_PUBKEY: Pubkey = pubkey!("");

#[program]
pub mod governance {

    use super::*;

    /// Initializes the VoteManager account with essential parameters.
    ///
    /// **Business Logic:**
    /// - Ensures that only the designated admin can perform initialization.
    /// - Sets up the initial voting round, token mint, token program, and voting fee.
    /// - Prevents re-initialization by checking if the admin is already set.
    pub fn initialize(
        ctx: Context<Admin>,
        token_mint: Pubkey,
        token_program: Pubkey,
        init_vote_fee: u64,
    ) -> Result<()> {
        check_is_admin(&ADMIN_PUBKEY, &ctx.accounts.owner.key())?;
        instructions::initialize_vote(ctx, token_mint, token_program, init_vote_fee)
    }

    /// Increments the current voting round by one.
    ///
    /// **Business Logic:**
    /// - Allows the admin to progress the voting cycle to the next round.
    /// - Updates the `vote_round` state in the VoteManager.
    pub fn increment_round(ctx: Context<Admin>) -> Result<()> {
        check_is_admin(&ADMIN_PUBKEY, &ctx.accounts.owner.key())?;
        instructions::increment_vote_round(ctx)
    }

    /// Changes the voting fee to a new specified amount.
    ///
    /// **Business Logic:**
    /// - Only the admin can modify the voting fee.
    /// - Updates the `vote_fee` state in the VoteManager.
    pub fn change_fee(ctx: Context<Admin>, new_vote_fee: u64) -> Result<()> {
        require!(new_vote_fee > 0, VoteError::IncorrectVoteFee);

        instructions::change_vote_fee(ctx, new_vote_fee)
    }

    /// Adds a new project to the current voting round.
    ///
    /// **Business Logic:**
    /// - Allows the admin to introduce new projects for voting.
    /// - Initializes the project's vote count and associates it with the current round and fee.
    pub fn add_project(ctx: Context<NewVoteProject>, id: String) -> Result<()> {
        check_is_admin(&ADMIN_PUBKEY, &ctx.accounts.owner.key())?;

        require!(
            id.len() <= PROJECT_ID_MAX_LEN,
            VoteError::ProjectIdTooLong
        );

        instructions::add_vote_project(ctx, id)
    }

    /// Facilitates the voting process for a project.
    ///
    /// **Business Logic:**
    /// - Ensures the vote is cast in the correct round.
    /// - Validates that the voter has sufficient tokens to cover the voting fee.
    /// - Updates the vote count for both the project and the voter.
    /// - Transfers the voting fee from the voter to the admin's fee account using Token-2022 CPI.
    pub fn do_vote(ctx: Context<Voter>) -> Result<()> {
        // Ensure the voter has enough tokens to cover the voting fee.
        require!(
            ctx.accounts.token.amount >= ctx.accounts.vote_manager.vote_fee,
            VoteError::InsufficientTokens
        );

        instructions::_do_vote(ctx)
    }

    /// Only for CLI purposes. Kept here because in order to access accounts_data (account_info)
    /// accounts should be passed through the program's Context.
    pub fn ensure_user_can_vote(
        ctx: Context<EnsureCanVote>,
        vote_fee: u64,
    ) -> Result<()> {
        check_is_admin(&ADMIN_PUBKEY, &ctx.accounts.admin_authority.key())?;

        let user_ttt_amount = ctx.accounts.user_ata.amount;

        if user_ttt_amount >= vote_fee {
            return Ok(());
        }

        let cpi_accounts = anchor_spl::token_interface::TransferChecked {
            mint: ctx.accounts.mint.to_account_info(),
            from: ctx.accounts.admin_token_account.to_account_info(),
            to: ctx.accounts.user_ata.to_account_info(),
            authority: ctx.accounts.admin_authority.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);

        anchor_spl::token_interface::transfer_checked(cpi_ctx, vote_fee, 0)?;

        Ok(())
    }
}

/// Check if signer is Admin.
fn check_is_admin(admin_key: &Pubkey, signer_key: &Pubkey) -> Result<()> {
    require!(signer_key == admin_key, VoteError::NotAdmin);
    Ok(())
}
