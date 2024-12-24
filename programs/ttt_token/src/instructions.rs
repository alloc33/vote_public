use anchor_lang::{prelude::*, solana_program::entrypoint::ProgramResult};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::spl_token_2022::extension::{
        group_member_pointer::GroupMemberPointer, metadata_pointer::MetadataPointer,
        mint_close_authority::MintCloseAuthority, permanent_delegate::PermanentDelegate,
    },
    token_interface::{
        spl_token_metadata_interface::state::TokenMetadata, token_metadata_initialize, Mint,
        Token2022, TokenAccount, TokenMetadataInitialize,
    },
};
use spl_pod::optional_keys::OptionalNonZeroPubkey;

use crate::{
    get_meta_list_size, get_mint_extensible_extension_data, get_mint_extension_data,
    update_account_lamports_to_minimum_balance, META_LIST_ACCOUNT_SEED,
};

/// Arguments required to create a new mint account.
///
/// **Business Logic:**
/// - Encapsulates all necessary metadata and initial supply information for token creation.
/// - Ensures consistency and integrity of token properties upon initialization.
#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct CreateMintAccountArgs {
    pub name: String,        // Name of the token.
    pub symbol: String,      // Symbol representing the token.
    pub uri: String,         // URI pointing to the token's metadata.
    pub initial_supply: u64, // Initial number of tokens to mint.
}

/// Accounts required to create a new mint account with extensions and associated metadata.
///
/// **Business Logic:**
/// - Initializes a new token mint with specific extensions like MetadataPointer and
///   GroupMemberPointer.
/// - Sets up the associated token account and additional metadata accounts.
/// - Ensures proper authority settings for minting, freezing, and delegating.
#[derive(Accounts)]
#[instruction(args: CreateMintAccountArgs)]
pub struct CreateMintAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>, // Payer for the transaction fees.
    #[account(mut)]
    /// CHECK: can be any account
    pub authority: Signer<'info>, // Authority who controls the mint.
    #[account(
        init,
        signer,
        payer = payer,
        mint::token_program = token_program,
        mint::decimals = 0, // Token has no decimal places.
        mint::authority = authority, // Sets the authority for minting.
        mint::freeze_authority = authority, // Authority that can freeze the mint.
        extensions::metadata_pointer::authority = authority, // Sets metadata pointer authority.
        extensions::metadata_pointer::metadata_address = mint, // Associates metadata with the mint.
        extensions::group_member_pointer::authority = authority, // Sets group member pointer authority.
        extensions::group_member_pointer::member_address = mint, // Associates group member pointer with the mint.
        extensions::close_authority::authority = authority, // Authority that can close the mint.
        extensions::permanent_delegate::delegate = authority, // Sets a permanent delegate for the mint.
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>, // The new mint account being created.
    #[account(
        init,
        payer = payer,
        associated_token::token_program = token_program,
        associated_token::mint = mint,
        associated_token::authority = authority, // Admin authority
    )]
    pub mint_token_account: Box<InterfaceAccount<'info, TokenAccount>>, /* Associated Token Account for the mint. */
    /// CHECK: This account's data is a buffer of TLV data
    #[account(
        init,
        space = get_meta_list_size(None), // Allocates space based on metadata.
        seeds = [META_LIST_ACCOUNT_SEED, mint.key().as_ref()], // Seeds for PDA derivation.
        bump,
        payer = payer,
    )]
    pub extra_metas_account: UncheckedAccount<'info>, // Account to hold additional metadata.
    pub system_program: Program<'info, System>, // Solana System program.
    pub associated_token_program: Program<'info, AssociatedToken>, /* Associated Token program
                                                 * interface. */
    pub token_program: Program<'info, Token2022>, // SPL Token-2022 program interface.
}

impl<'info> CreateMintAccount<'info> {
    /// Initializes token metadata using CPI with the TokenMetadataInitialize interface.
    ///
    /// **Business Logic:**
    /// - Sets up on-chain metadata for the token, including name, symbol, and URI.
    /// - Associates the metadata with the token mint and authority.
    /// - Ensures that the metadata is correctly linked to the mint account.
    ///
    /// **Parameters:**
    /// - `name`: Name of the token.
    /// - `symbol`: Symbol representing the token.
    /// - `uri`: URI pointing to the token's metadata.
    ///
    /// **Returns:**
    /// - `ProgramResult`: Indicates success or failure of the metadata initialization.
    fn initialize_token_metadata(
        &self,
        name: String,
        symbol: String,
        uri: String,
    ) -> ProgramResult {
        let cpi_accounts = TokenMetadataInitialize {
            token_program_id: self.token_program.to_account_info(),
            mint: self.mint.to_account_info(),
            metadata: self.mint.to_account_info(), /* Metadata account is the mint itself since
                                                    * data is stored there */
            mint_authority: self.authority.to_account_info(),
            update_authority: self.authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(self.token_program.to_account_info(), cpi_accounts);
        token_metadata_initialize(cpi_ctx, name, symbol, uri)?;
        Ok(())
    }
}

/// Handler for creating a new mint account.
///
/// **Business Logic:**
/// - Initializes token metadata and verifies its integrity.
/// - Sets up various extensions to enhance token functionalities.
/// - Mints the initial supply of tokens to the associated token account.
/// - Revokes mint authority to prevent further minting, ensuring a fixed total supply.
/// - Ensures the mint account is rent-exempt by updating lamports if necessary.
///
/// **Parameters:**
/// - `ctx`: Context containing the accounts required for mint account creation.
/// - `args`: Arguments containing token metadata and initial supply information.
///
/// **Returns:**
/// - `Result<()>`: Indicates success or failure of the mint account creation process.
pub fn handler(ctx: Context<CreateMintAccount>, args: CreateMintAccountArgs) -> Result<()> {
    // Initialize token metadata by invoking the metadata initialization CPI.
    msg!("Initializing token metadata...");
    ctx.accounts.initialize_token_metadata(
        args.name.clone(),
        args.symbol.clone(),
        args.uri.clone(),
    )?;
    msg!("Token metadata initialized.");

    // Reload the mint account to ensure it's updated with the latest data.
    ctx.accounts.mint.reload()?;
    let mint_data = &mut ctx.accounts.mint.to_account_info();

    // Retrieve and verify token metadata extension data.
    let metadata = get_mint_extensible_extension_data::<TokenMetadata>(mint_data)?;
    assert_eq!(metadata.mint, ctx.accounts.mint.key());
    assert_eq!(metadata.name, args.name);
    assert_eq!(metadata.symbol, args.symbol);
    assert_eq!(metadata.uri, args.uri);
    msg!("Token metadata verified.");

    // Verify the MetadataPointer extension to ensure correct metadata association.
    let metadata_pointer = get_mint_extension_data::<MetadataPointer>(mint_data)?;
    let mint_key: Option<Pubkey> = Some(ctx.accounts.mint.key());
    let authority_key: Option<Pubkey> = Some(ctx.accounts.authority.key());
    assert_eq!(
        metadata_pointer.metadata_address,
        OptionalNonZeroPubkey::try_from(mint_key)?
    );
    assert_eq!(
        metadata_pointer.authority,
        OptionalNonZeroPubkey::try_from(authority_key)?
    );
    msg!("MetadataPointer extension verified.");

    // Verify the PermanentDelegate extension to ensure the delegate is correctly set.
    let permanent_delegate = get_mint_extension_data::<PermanentDelegate>(mint_data)?;
    assert_eq!(
        permanent_delegate.delegate,
        OptionalNonZeroPubkey::try_from(authority_key)?
    );
    msg!("PermanentDelegate extension verified.");

    // Verify the MintCloseAuthority extension to ensure the close authority is correctly set.
    let close_authority = get_mint_extension_data::<MintCloseAuthority>(mint_data)?;
    assert_eq!(
        close_authority.close_authority,
        OptionalNonZeroPubkey::try_from(authority_key)?
    );
    msg!("MintCloseAuthority extension verified.");

    // Verify the GroupMemberPointer extension to ensure proper group membership.
    let group_member_pointer = get_mint_extension_data::<GroupMemberPointer>(mint_data)?;
    assert_eq!(
        group_member_pointer.authority,
        OptionalNonZeroPubkey::try_from(authority_key)?
    );
    assert_eq!(
        group_member_pointer.member_address,
        OptionalNonZeroPubkey::try_from(mint_key)?
    );
    msg!("GroupMemberPointer extension verified.");

    // **Mint the Initial Supply to Receiver's ATA using Token-2022 CPI**
    msg!("Minting initial supply to receiver's ATA...");
    let cpi_accounts_mint_to = anchor_spl::token_2022::MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.mint_token_account.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };

    let cpi_ctx_mint_to = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts_mint_to,
    );

    // Execute the minting of tokens to the associated token account.
    anchor_spl::token_2022::mint_to(cpi_ctx_mint_to, args.initial_supply)?;
    msg!("Initial supply minted.");

    // **Revoke Mint Authority to Fix the Total Supply**
    msg!("Revoking mint authority...");
    let cpi_accounts_set_authority = anchor_spl::token_2022::SetAuthority {
        account_or_mint: ctx.accounts.mint.to_account_info(),
        current_authority: ctx.accounts.authority.to_account_info(),
    };

    let cpi_ctx_set_authority = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts_set_authority,
    );

    // Revoke the mint authority by setting it to `None`, preventing further minting.
    anchor_spl::token_2022::set_authority(
        cpi_ctx_set_authority,
        anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
        None,
    )?;
    msg!("Mint authority revoked.");

    // **Update Lamports to Minimum Balance**
    msg!("Updating lamports to minimum balance...");
    update_account_lamports_to_minimum_balance(
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
    )?;
    msg!("Lamports updated to minimum balance.");

    Ok(())
}

/// Accounts required for transferring QZL tokens.
///
/// **Business Logic:**
/// - Ensures that both the source and destination token accounts are mutable.
///
/// INFO: Currently used only in tests
#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(mut)] // Ensure the source token account is writable.
    pub from_ata: Box<InterfaceAccount<'info, TokenAccount>>, // Source Associated Token Account.
    #[account(mut)] // Ensure the destination token account is writable.
    pub to_ata: Box<InterfaceAccount<'info, TokenAccount>>, /* Destination Associated Token
                                                             * Account. */
    #[account(signer)] // The authority for the `from_ata` must sign the transaction.
    pub authority: Signer<'info>, // Authority of the source token account.
    // Bind to QZL token mint! Other mint addresses will reject the transaction.
    #[account(address = from_ata.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>, // Token mint associated with the transfer.
    pub token_program: Program<'info, Token2022>, // SPL Token-2022 program interface.
}

/// Accounts required to check constraints related to mint extensions.
///
/// **Business Logic:**
/// - Validates that all necessary extensions are correctly configured for the mint.
/// - Ensures that the authority settings align with the governance requirements.
#[derive(Accounts)]
#[instruction()]
pub struct CheckMintExtensionConstraints<'info> {
    #[account(mut)]
    /// CHECK: can be any account
    pub authority: Signer<'info>, // Authority managing the mint extensions.
    #[account(
        extensions::metadata_pointer::authority = authority, // Ensures MetadataPointer authority is correct.
        extensions::metadata_pointer::metadata_address = mint, // Ensures MetadataPointer is associated with the mint.
        extensions::group_member_pointer::authority = authority, // Ensures GroupMemberPointer authority is correct.
        extensions::group_member_pointer::member_address = mint, // Ensures GroupMemberPointer is associated with the mint.
        extensions::close_authority::authority = authority, // Ensures MintCloseAuthority is correct.
        extensions::permanent_delegate::delegate = authority, // Ensures PermanentDelegate is correctly set.
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>, // The mint account being checked.
}
