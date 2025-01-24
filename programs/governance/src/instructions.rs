use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

pub const PROJECT_ID_MAX_LEN: usize = 50;
pub const VOTER_NAMESPACE: &str = "voter";

pub fn initialize_vote(
    ctx: Context<Admin>,
    token_mint: Pubkey,
    token_program: Pubkey,
    init_vote_fee: u64,
) -> Result<()> {
    // Set the initial state of the VoteManager.
    ctx.accounts.vote_data.vote_round = 1;
    ctx.accounts.vote_data.admin = ctx.accounts.owner.key();
    ctx.accounts.vote_data.tk_mint = token_mint;
    ctx.accounts.vote_data.tk_program = token_program;
    ctx.accounts.vote_data.vote_fee = init_vote_fee;
    Ok(())
}

/// Increments the current voting round by one.
///
/// **Business Logic:**
/// - Allows the admin to progress the voting cycle to the next round.
/// - Updates the `vote_round` state in the VoteManager.
pub fn increment_vote_round(ctx: Context<Admin>) -> Result<()> {
    // Increment the voting round.
    ctx.accounts.vote_data.vote_round += 1;
    Ok(())
}

/// Changes the voting fee to a new specified amount.
///
/// **Business Logic:**
/// - Only the admin can modify the voting fee.
/// - Updates the `vote_fee` state in the VoteManager.
pub fn change_vote_fee(ctx: Context<Admin>, new_vote_fee: u64) -> Result<()> {
    // Update the voting fee.
    ctx.accounts.vote_data.vote_fee = new_vote_fee;
    Ok(())
}

/// Adds a new project to the current voting round.
///
/// **Business Logic:**
/// - Allows the admin to introduce new projects for voting.
/// - Initializes the project's vote count and associates it with the current round and fee.
pub fn add_vote_project(ctx: Context<NewVoteProject>, id: String) -> Result<()> {
    // Initialize project data with reference to the VoteManager.
    ctx.accounts.project_data.vote_manager = ctx.accounts.vote_manager.admin;
    ctx.accounts.project_data.id = id;
    ctx.accounts.project_data.vote_count = 0;
    ctx.accounts.project_data.vote_round = ctx.accounts.vote_manager.vote_round;

    Ok(())
}

/// Facilitates the voting process for a project.
///
/// **Business Logic:**
/// - Ensures the vote is cast in the correct round.
/// - Validates that the voter has sufficient tokens to cover the voting fee.
/// - Updates the vote count for both the project and the voter.
/// - Transfers the voting fee from the voter to the admin's fee account using Token-2022 CPI.
pub fn _do_vote(ctx: Context<Voter>) -> Result<()> {
    // Prepare the CPI context for transferring the voting fee.
    let cpi_accounts = anchor_spl::token_interface::TransferChecked {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.token.to_account_info(),
        to: ctx.accounts.admin_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(), /* The voter must authorize this
                                                           * transfer. */
    };

    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);

    // Execute the transfer of the voting fee.
    anchor_spl::token_interface::transfer_checked(
        cpi_ctx,
        ctx.accounts.vote_manager.vote_fee,
        0, // No decimal places for the fee.
    )?;

    // Increment vote counts for the project and the voter.
    ctx.accounts.project.vote_count += 1;
    ctx.accounts.voter_data.vote_count += 1;
    ctx.accounts.voter_data.last_voted_round = ctx.accounts.project.vote_round;
    ctx.accounts.voter_data.voter = ctx.accounts.signer.key();
    ctx.accounts.voter_data.project_name = (*ctx.accounts.project.id).to_string();

    Ok(())
}

/// Defines the accounts required for administrative actions.
///
/// **Business Logic:**
/// - Manages the VoteManager account using PDA derivation with seeds.
/// - Ensures the admin is the signer and has authority over the VoteManager.
#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
            init_if_needed,
            payer = owner,
            space = 8 + VoteManager::INIT_SPACE,
            seeds = [
                b"vote_manager",
                owner.key().as_ref()
            ],
            bump
        )]
    pub vote_data: Account<'info, VoteManager>, /* The VoteManager account managing the
                                                 * voting process. */
    #[account(mut)]
    pub owner: Signer<'info>, // The admin's signer account.
    pub system_program: Program<'info, System>, // Solana System program.
}

/// Defines the accounts required to add a new project for voting.
///
/// **Business Logic:**
/// - Initializes a new ProjectData account with PDA derivation ensuring uniqueness.
/// - Associates the project with the current voting round and fee.
#[derive(Accounts)]
#[instruction(id:String)]
pub struct NewVoteProject<'info> {
    #[account(
            // Initialize a new ProjectData account with unique PDA seeds.
            init,
            payer = owner,
            space = 8 + ProjectData::INIT_SPACE,
            seeds = [
                id.as_bytes(),                         // Unique project identifier.
                &vote_manager.vote_round.to_le_bytes(), // Current voting round to ensure uniqueness across rounds.
                owner.key().as_ref()                    // Admin's public key for authorization.
            ],
            bump)]
    pub project_data: Account<'info, ProjectData>, // The new project's data account.
    #[account(
            mut,
            constraint = vote_manager.admin == owner.key() // Ensure only the admin can add projects.
        )]
    pub vote_manager: Account<'info, VoteManager>, // Reference to the VoteManager account.
    #[account(mut)]
    pub owner: Signer<'info>, // The admin's signer account.
    pub system_program: Program<'info, System>, // Solana System program.
}

/// Defines the accounts required for casting a vote.
///
/// **Business Logic:**
/// - Initializes a VoterData account to track the voter's activity in the current round.
/// - Ensures the voter's token account is authorized and has sufficient balance.
/// - Facilitates the transfer of voting fees from the voter's token account to the admin's fee
///   account.
#[derive(Accounts)]
pub struct Voter<'info> {
    #[account(
            init_if_needed,
            payer = signer,
            space = 8 + VoterData::INIT_SPACE,
            seeds = [
                VOTER_NAMESPACE.as_bytes(),
                &[project.vote_round, 1, 1, 1, 1], // Seed combining theround number with padding for uniqueness.
                signer.key().as_ref(),     // Voter's public key to ensure unique PDA per voter per round.
                project.id.as_ref(),
            ],
            bump,
            constraint = project.vote_round == vote_manager.vote_round @ VoteError::WrongRound
            )]
    pub voter_data: Account<'info, VoterData>, // Tracks the voter's voting activity.
    #[account(mut)]
    pub signer: Signer<'info>, // The voter's signer account.
    #[account(mut)]
    pub vote_manager: Account<'info, VoteManager>, // Reference to the VoteManager account.
    #[account(
            mut,
            associated_token::token_program = token_program,
            associated_token::mint = vote_manager.tk_mint,
            associated_token::authority = vote_manager.admin,
        )]
    pub admin_token_account: InterfaceAccount<'info, TokenAccount>, /* Account which store
                                                                     * initial supply of ttt
                                                                     * and which is used by
                                                                     * a program to deduct
                                                                     * voting fee. */
    #[account(mut)]
    pub project: Account<'info, ProjectData>, // The project being voted for.
    #[account(
      mut,
      constraint = mint.key() == vote_manager.tk_mint @ VoteError::WrongMint
    )]
    pub mint: InterfaceAccount<'info, Mint>, // The governance token mint (ttt).
    #[account(mut)]
    pub token: InterfaceAccount<'info, TokenAccount>, /* Voter's token account holding ttt
                                                       * tokens. */
    pub token_program: Interface<'info, TokenInterface>, /* Token program interface for
                                                          * token operations. */
    pub system_program: Program<'info, System>, // Solana System program.
}

/// Represents the VoteManager account responsible for managing voting rounds and projects.
///
/// **Fields:**
/// - `admin`: The admin's public key with authority over the VoteManager.
/// - `tk_mint`: The token mint associated with the governance token.
/// - `tk_program`: The SPL Token program ID.
/// - `vote_round`: The current active voting round.
/// - `vote_fee`: The fee required to cast a vote.
#[account]
#[derive(InitSpace)]
pub struct VoteManager {
    pub admin: Pubkey,      // Admin's public key.
    pub tk_mint: Pubkey,    // Token mint for governance token (ttt).
    pub tk_program: Pubkey, // SPL Token program ID.
    pub vote_round: u8,     // Current voting round.
    pub vote_fee: u64,      // Fee required to cast a vote.
}

/// Represents the ProjectData account for each project under governance.
///
/// **Fields:**
/// - `vote_manager`: Reference to the VoteManager's admin.
/// - `id`: Unique identifier for the project.
/// - `name`: Name of the project.
/// - `vote_round`: The voting round in which the project is active.
/// - `vote_count`: Total number of votes the project has received.
/// - `vote_fee`: The fee associated with voting for this project.
#[account]
#[derive(InitSpace)]
pub struct ProjectData {
    pub vote_manager: Pubkey, // Reference to the VoteManager's admin.
    #[max_len(PROJECT_ID_MAX_LEN)]
    pub id: String, // Unique project identifier.
    pub vote_round: u8,       // Voting round associated with the project.
    pub vote_count: u64,      // Total votes received.
}

/// Represents the VoterData account tracking a voter's activity.
///
/// **Fields:**
/// - `voter`: The voter's public key.
/// - `project_name`: The name of the project the voter last voted for.
/// - `last_voted_round`: The last round in which the voter cast a vote.
/// - `vote_count`: Total number of votes the voter has cast.
#[account]
#[derive(InitSpace)]
pub struct VoterData {
    pub voter: Pubkey, // Voter's public key.
    #[max_len(50)]
    pub project_name: String, // Name of the project voted for.
    pub last_voted_round: u8, // Last round the voter participated in.
    pub vote_count: u64, // Total votes cast by the voter.
}

/// Defines custom error codes for the VoteProject program.
/// Provides clear and descriptive error messages for various failure scenarios.
#[error_code]
pub enum VoteError {
    #[msg("Vote program with admin: do not initialize!")]
    NotAdmin, // Triggered when a non-admin attempts an admin-only action.
    #[msg("Wrong vote round.")]
    WrongRound, // Triggered when a vote is cast in an incorrect round.
    #[msg("Admin account already initialized.")]
    InsufficientTokens, // Triggered when a voter lacks sufficient tokens to cast a vote.
    #[msg("ProjectIdTooLong")]
    ProjectIdTooLong,
    #[msg("IncorrectVoteFee")]
    IncorrectVoteFee,
    #[msg("WrongMint")]
    WrongMint,
}

/// Type which is used by CLI.
#[derive(Accounts)]
#[instruction(vote_fee:u64)]
pub struct EnsureCanVote<'info> {
    #[account(mut)]
    pub signer: Signer<'info>, // The voter's signer account.
    #[account(
            mut,
            associated_token::token_program = token_program,
            associated_token::mint = mint,
            associated_token::authority = admin_authority,
        )]
    pub admin_token_account: InterfaceAccount<'info, anchor_spl::token_interface::TokenAccount>,
    pub admin_authority: Signer<'info>, // The explicit authority for admin_token_account.
    pub mint: InterfaceAccount<'info, Mint>, /* The governance
                                         * token mint
                                         * (ttt). */
    #[account(
           init_if_needed,
           payer = signer,
           associated_token::token_program = token_program,
           associated_token::mint = mint,
           associated_token::authority = signer,
           constraint = user_ata.owner == signer.key(),
           constraint = user_ata.mint == mint.key()
        )]
    pub user_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
