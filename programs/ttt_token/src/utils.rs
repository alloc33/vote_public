use anchor_lang::{
    prelude::Result,
    solana_program::{
        account_info::AccountInfo, program::invoke, pubkey::Pubkey, rent::Rent,
        system_instruction::transfer, sysvar::Sysvar,
    },
    Lamports,
};
use anchor_spl::token_interface::spl_token_2022::{
    extension::{BaseStateWithExtensions, Extension, StateWithExtensions},
    solana_zk_token_sdk::zk_token_proof_instruction::Pod,
    state::Mint,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_type_length_value::variable_len_pack::VariableLenPack;

// Seed constants used for deriving PDAs related to account metadata.
pub const APPROVE_ACCOUNT_SEED: &[u8] = b"approve-account";
pub const META_LIST_ACCOUNT_SEED: &[u8] = b"extra-account-metas";

/// Ensures that the specified account has at least the minimum required lamports.
///
/// **Business Logic:**
/// - Maintains rent-exemption by funding accounts that fall below the required balance.
/// - Transfers lamports from the payer to the target account if necessary.
///
/// **Parameters:**
/// - `account`: The account to check and potentially fund.
/// - `payer`: The account providing additional lamports.
/// - `system_program`: The Solana System program for invoking transfers.
pub fn update_account_lamports_to_minimum_balance<'info>(
    account: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
) -> Result<()> {
    // Calculate the additional lamports needed to reach the minimum balance.
    let extra_lamports = Rent::get()?.minimum_balance(account.data_len()) - account.get_lamports();
    if extra_lamports > 0 {
        // Invoke a system transfer to fund the account.
        invoke(
            &transfer(payer.key, account.key, extra_lamports),
            &[payer, account, system_program],
        )?;
    }
    Ok(())
}

/// Retrieves extension data of type `T` from a mint account.
///
/// **Business Logic:**
/// - Allows the program to access and validate custom extensions associated with the token mint.
/// - Facilitates interaction with extended functionalities like metadata pointers and group
///   memberships.
///
/// **Parameters:**
/// - `account`: The mint account from which to retrieve extension data.
///
/// **Returns:**
/// - The extension data of type `T` if successfully retrieved.
pub fn get_mint_extensible_extension_data<T: Extension + VariableLenPack>(
    account: &mut AccountInfo,
) -> Result<T> {
    let mint_data = account.data.borrow();
    let mint_with_extension = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let extension_data = mint_with_extension.get_variable_len_extension::<T>()?;
    Ok(extension_data)
}

/// Retrieves extension data of type `T` from a mint account.
///
/// **Business Logic:**
/// - Similar to `get_mint_extensible_extension_data` but tailored for fixed-size extensions.
/// - Ensures that specific extensions like `MetadataPointer` and `PermanentDelegate` are correctly
///   configured.
///
/// **Parameters:**
/// - `account`: The mint account from which to retrieve extension data.
///
/// **Returns:**
/// - The extension data of type `T` if successfully retrieved.
pub fn get_mint_extension_data<T: Extension + Pod>(account: &mut AccountInfo) -> Result<T> {
    let mint_data = account.data.borrow();
    let mint_with_extension = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let extension_data = *mint_with_extension.get_extension::<T>()?;
    Ok(extension_data)
}

/// Constructs a list of additional account metadata based on the presence of an approve account.
///
/// **Business Logic:**
/// - Manages permissions and authorities for token operations by maintaining metadata.
/// - Supports scenarios where specific approval mechanisms are required.
///
/// **Parameters:**
/// - `approve_account`: An optional public key representing an account with approval rights.
///
/// **Returns:**
/// - A vector of `ExtraAccountMeta` containing the metadata if `approve_account` is provided.
pub fn get_meta_list(approve_account: Option<Pubkey>) -> Vec<ExtraAccountMeta> {
    if let Some(approve_account) = approve_account {
        return vec![ExtraAccountMeta {
            discriminator: 0,                           // Identifier for the type of metadata.
            address_config: approve_account.to_bytes(), // Encoded approve account address.
            is_signer: false.into(),                    /* Indicates whether the account is a
                                                         * signer. */
            is_writable: true.into(), // Indicates whether the account is writable.
        }];
    }
    vec![] // Return an empty list if no approve account is provided.
}

/// Calculates the size required for the metadata list account based on the number of metadata
/// entries.
///
/// **Business Logic:**
/// - Allocates sufficient space for storing account metadata.
///
/// **Parameters:**
/// - `approve_account`: An optional public key representing an account with approval rights.
///
/// **Returns:**
/// - The size in bytes required for the metadata list account.
pub fn get_meta_list_size(approve_account: Option<Pubkey>) -> usize {
    // The size is calculated based on the number of metadata entries (either 0 or 1).
    ExtraAccountMetaList::size_of(get_meta_list(approve_account).len()).unwrap()
}
