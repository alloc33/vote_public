import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { Governance } from "../target/types/governance";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  RpcResponseAndContext,
  SignatureResult,
} from "@solana/web3.js";
import { TokenExtensions } from "../target/types/token_extensions";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";

// -------------------- Constants --------------------

// Initialize the Anchor provider using environment variables.
// This provider will be used to interact with the Solana cluster.
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// Reference to the deployed VoteProject program.
const program = anchor.workspace.Governance as Program<Governance>;

// Reference to the TokenExtensions program for handling token-related operations.
const tokenProgram = anchor.workspace.TokenExtensions as Program<TokenExtensions>;

// Define the initial supply of the TTT token.
const TTT_TOKEN_INITIAL_SUPPLY = 450_000_000;

// Namespace used for deriving Vouter PDAs. Helps in organizing related accounts.
const VOUTER_NAMESPACE = "vouter";

// Default amount of SOL to airdrop to test accounts to cover transaction fees.
const DEFAULT_AIRDROP_SOL = 1;

// -------------------- Helper Functions --------------------

/**
 * Derives a Project PDA based on project index, round, and admin public key.
 * @param projectIdx - Unique identifier for the project.
 * @param round - Current voting round.
 * @param adminPubkey - Admin's public key.
 * @returns PublicKey of the Project PDA.
 */
function deriveProjectPda(projectIdx: string, round: number, adminPubkey: PublicKey): PublicKey {
  // Use a single-byte buffer for the round number as per the original logic.
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(projectIdx),
      Buffer.from([round]), // 1-byte round number without padding
      adminPubkey.toBuffer(),
    ],
    program.programId
  )[0];
}

/**
 * Derives a Vouter PDA based on round and voter's public key.
 * @param round - Current voting round.
 * @param voterPubkey - Voter's public key.
 * @returns PublicKey of the Vouter PDA.
 */
function deriveVouterPda(round: number, voterPubkey: PublicKey): PublicKey {
  // Use a 6-byte buffer with padding as per the original logic.
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VOUTER_NAMESPACE),
      Buffer.from([round, 1, 1, 1, 1, 1]), // 1-byte round number with 5-byte padding
      voterPubkey.toBuffer(),
    ],
    program.programId
  )[0];
}

/**
 * Derives the Mint Token Account PDA for a given token mint and admin.
 * This account holds the tokens minted and managed by the admin.
 *
 * @param mintPubkey - Token mint's public key.
 * @param adminPubkey - Admin's public key.
 * @returns PublicKey of the Mint Token Account PDA.
 */
function deriveMintTokenAccount(mintPubkey: PublicKey, adminPubkey: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    mintPubkey,
    adminPubkey,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_PROGRAM_ID
  );
}


/**
* Generates project unique identifier
*/
function generateProjectIdx(length = 20): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Usage:
const doubleVoteProjectIdx = generateProjectIdx(20);
console.log(doubleVoteProjectIdx); // e.g. "aB3xYz12WpQ9..." (20 random chars)
/**
 * Airdrops SOL to a given public key if the balance is below a specified threshold.
 * Ensures that test accounts have sufficient funds to cover transaction fees.
 *
 * @param connection - Solana connection object.
 * @param publicKey - Public key to airdrop SOL to.
 * @param minBalanceInSol - Minimum balance required in SOL.
 */
async function airdropIfNeeded(
  connection: Connection,
  publicKey: PublicKey,
  minBalanceInSol: number = DEFAULT_AIRDROP_SOL
): Promise<void> {
  try {
    // Retrieve the current balance of the account in lamports.
    const currentBalance = await connection.getBalance(publicKey);
    const currentBalanceInSol = currentBalance / LAMPORTS_PER_SOL;

    // Check if the current balance meets the minimum required balance.
    if (currentBalanceInSol < minBalanceInSol) {
      const requiredAirdrop = minBalanceInSol - currentBalanceInSol;

      // Request an airdrop of the required amount.
      const signature = await connection.requestAirdrop(
        publicKey,
        requiredAirdrop * LAMPORTS_PER_SOL
      );

      // Confirm the airdrop transaction.
      const latestBlockhash = await connection.getLatestBlockhash();
      const confirmationResult: RpcResponseAndContext<SignatureResult> =
        await connection.confirmTransaction(
          {
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          "finalized"
        );

      // Handle any errors that occurred during the airdrop.
      if (confirmationResult.value.err) {
        throw new Error(
          `Airdrop transaction failed: ${JSON.stringify(confirmationResult.value.err)}`
        );
      }

      console.log(
        `Airdropped ${requiredAirdrop.toFixed(2)} SOL to ${publicKey.toBase58()}.`
      );
    } else {
      console.log(
        `Account ${publicKey.toBase58()} already has ${currentBalanceInSol.toFixed(
          2
        )} SOL, no airdrop needed.`
      );
    }
  } catch (error) {
    console.error("Error in airdropIfNeeded function:", error);
    throw error;
  }
}

/**
 * Fetches the token balance for a given token account.
 * This function retrieves the balance in a human-readable format (UI amount).
 *
 * @param connection - Solana connection object.
 * @param tokenAccount - Token account public key.
 * @returns Balance in UI amount.
 */
async function getTokenBalance(connection: Connection, tokenAccount: PublicKey): Promise<number> {
  const balance = await connection.getTokenAccountBalance(tokenAccount);
  return balance.value.uiAmount || 0;
}

// -------------------- Test Suite --------------------

describe("ttt-labs-tests", () => {
  // -------------------- Variable Declarations --------------------
  let tokenMint: Keypair; // Keypair for the token mint authority.
  let voter: Keypair; // Keypair representing a voter.
  let voterAta: PublicKey; // Associated Token Account for the voter.
  let mintTokenAccount: PublicKey; // Token account holding the minted tokens.
  let adminWallet: anchor.Wallet; // Admin's wallet, used to sign transactions.
  let admin: Keypair; // Keypair corresponding to the admin's wallet.
  let voteManagerPda: PublicKey; // PDA for managing voting rounds and projects.
  let extraMetasAccount: PublicKey; // Additional metadata account PDA.
  let projectIdx: string; // Identifier for a specific project.
  let unauthorizedAttacker: Keypair; // Keypair representing an unauthorized user attempting actions.

  // -------------------- Hooks --------------------
  before(async () => {
    try {
      // Setup initial values..
      tokenMint = Keypair.generate();
      voter = Keypair.generate();
      adminWallet = provider.wallet as anchor.Wallet;
      admin = adminWallet.payer;
      unauthorizedAttacker = Keypair.generate();

      // Derive the VoteManager PDA using the "vote_manager" seed and admin's public key.
      voteManagerPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_manager"), adminWallet.publicKey.toBuffer()],
        program.programId
      )[0];

      // Define a project identifier.
      projectIdx = "projectVote1";

      // Derive the extraMetasAccount PDA using specific seeds.
      extraMetasAccount = PublicKey.findProgramAddressSync(
        [
          Buffer.from("extra-account-metas"),
          tokenMint.publicKey.toBuffer(),
        ],
        tokenProgram.programId
      )[0];

      console.log("\nPerforming necessary airdrops...\n");

      // Airdrop SOL to the voter and unauthorized attacker to ensure they can cover transaction fees.
      await airdropIfNeeded(provider.connection, voter.publicKey, DEFAULT_AIRDROP_SOL);
      await airdropIfNeeded(provider.connection, unauthorizedAttacker.publicKey, DEFAULT_AIRDROP_SOL);

      // Define the accounts required for creating the token mint and associated accounts.
      const accountsStrict = {
        payer: provider.publicKey, // The account paying for the transaction fees.
        authority: provider.publicKey, // The authority for the mint.
        mint: tokenMint.publicKey, // The public key for the token mint.
        mintTokenAccount: deriveMintTokenAccount(tokenMint.publicKey, adminWallet.publicKey), // The token account PDA.
        extraMetasAccount: extraMetasAccount, // Additional metadata account PDA.
        systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID, // Associated Token program ID.
        tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      };

      // Create the token mint with initial supply and associated metadata.
      await tokenProgram.methods
        .createMintAccount({
          name: "TTT Labs Token", // Name of the token.
          symbol: "TTT", // Symbol for the token.
          uri: "https://my-token-data.com/metadata.json", // URI pointing to token metadata.
          initialSupply: new anchor.BN(TTT_TOKEN_INITIAL_SUPPLY), // Initial supply of the token.
        })
        .accountsStrict(accountsStrict)
        .signers([tokenMint, admin]) // Signers required for the transaction.
        .rpc();

      // Derive the mint token account PDA after mint creation.
      mintTokenAccount = deriveMintTokenAccount(tokenMint.publicKey, adminWallet.publicKey);

      // Define the accounts required to initialize the VoteManager.
      const initializeAccounts = {
        voteData: voteManagerPda, // PDA for the VoteManager.
        owner: adminWallet.publicKey, // Admin's public key as the owner.
        systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
      };

      // Initialize the VoteManager with the token mint, token program ID, and vote fee.
      await program.methods
        .initialize(tokenMint.publicKey, TOKEN_2022_PROGRAM_ID, new anchor.BN(100))
        .accounts(initializeAccounts)
        .rpc();

      // Fetch and assert the initial state of the VoteManager to ensure correct initialization.
      const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
      expect(voteManagerAccount.voteRound).to.equal(1);
      expect(voteManagerAccount.admin.toBase58()).to.equal(adminWallet.publicKey.toBase58()); // Admin should be correctly set.
      expect(voteManagerAccount.tkMint.toBase58()).to.equal(tokenMint.publicKey.toBase58()); // Token mint should be correctly set.
      expect(voteManagerAccount.tkProgram.toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58()); // Token program ID should be correctly set.
      expect(voteManagerAccount.voteFee.toNumber()).to.equal(100); // Vote fee should be correctly set.

      console.log("VoteManager initialized successfully.");
    } catch (error) {
      console.error("Error in before hook:", error);
      throw error; // Propagate the error to fail the tests if setup fails.
    }

    try {
      console.log("Setting up voter's ATA...");
      // Derive the Associated Token Account (ATA) for the voter.
      voterAta = await getAssociatedTokenAddress(
        tokenMint.publicKey,
        voter.publicKey,
        true, // Allow PDA derivation.
        TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
        ASSOCIATED_PROGRAM_ID // Associated Token program ID.
      );

      // Check if the voter's ATA already exists to avoid unnecessary transactions.
      const ataAccount = await provider.connection.getAccountInfo(voterAta);
      if (!ataAccount) {
        // If ATA doesn't exist, create it.
        const ataTransaction = new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            provider.publicKey, // Payer of the transaction fees.
            voterAta,           // PDA address for the ATA.
            voter.publicKey,    // Owner of the ATA.
            tokenMint.publicKey,// Token mint for the ATA.
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_PROGRAM_ID
          )
        );

        await provider.sendAndConfirm(ataTransaction); // Send and confirm the ATA creation transaction.
        console.log("Voter's ATA created.");
      } else {
        console.log(`ATA for ${voter.publicKey.toBase58()} already exists.`);
      }

      // Define the accounts involved in transferring TTT tokens from the mint to the voter.
      const transferAccounts = {
        fromAta: mintTokenAccount, // Source ATA holding the minted tokens.
        toAta: voterAta,           // Destination ATA to receive tokens.
        mint: tokenMint.publicKey, // Token mint associated with the transfer.
        tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      };

      // Execute the token transfer of 10,000 TTT from admin to voter.
      await tokenProgram.methods
        .transferTokens(new anchor.BN(10_000)) // Amount of TTT tokens to transfer.
        .accounts(transferAccounts)
        .signers([admin]) // Admin signs the transaction.
        .rpc();

      console.log("TTT tokens transferred to test voter.");
    } catch (error) {
      console.error("Error in beforeEach hook:", error);
      throw error; // Propagate the error to fail the tests if setup fails.
    }
  });

  // -------------------- Test Cases --------------------

  /**
   * Test Case: Admin Initialization with Correct Admin Key
   * Purpose: Verify that the VoteManager is correctly initialized with the admin's key.
   */
  it("Admin Initialization with Correct Admin Key", async () => {
    console.log("\n");
    // Fetch the current state of the VoteManager account.
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);

    // Assert that the initial voting round is set to 1.
    expect(voteManagerAccount.voteRound).to.equal(1);

    // Assert that the admin is correctly set.
    expect(voteManagerAccount.admin.toBase58()).to.equal(adminWallet.publicKey.toBase58());

    // Assert that the token mint is correctly set.
    expect(voteManagerAccount.tkMint.toBase58()).to.equal(tokenMint.publicKey.toBase58());

    // Assert that the token program ID is correctly set.
    expect(voteManagerAccount.tkProgram.toBase58()).to.equal(TOKEN_2022_PROGRAM_ID.toBase58());

    // Assert that the vote fee is correctly set to 100.
    expect(voteManagerAccount.voteFee.toNumber()).to.equal(100);
  });

  /**
   * Test Case: Admin Initialization with Incorrect Admin Key
   * Purpose: Ensure that initializing the VoteManager with an unauthorized admin fails as expected.
   */
  it("Admin Initialization with Incorrect Admin Key", async () => {
    // Derive a VoteManager PDA using an unauthorized attacker's public key.
    const unauthorizedVoteManagerPda = PublicKey.findProgramAddressSync(
      [Buffer.from("vote_manager"), unauthorizedAttacker.publicKey.toBuffer()],
      program.programId
    )[0];

    // Define the accounts for the unauthorized initialization attempt.
    const initializeAccounts = {
      voteData: unauthorizedVoteManagerPda,
      owner: unauthorizedAttacker.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      // Attempt to initialize the VoteManager with unauthorized admin credentials.
      await program.methods
        .initialize(tokenMint.publicKey, TOKEN_2022_PROGRAM_ID, new anchor.BN(100))
        .accounts(initializeAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      // Assert that the error code corresponds to unauthorized admin action.
      expect(err.error.errorCode.code).to.equal("NotAdmin");
    }
  });

  /**
   * Test Case: Duplicate Initialization
   * Purpose: Verify that attempting to initialize the VoteManager more than once fails as expected.
   */
  it("Duplicate Initialization", async () => {
    // Define the accounts for the second initialization attempt.
    const initializeAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      // Attempt to re-initialize the VoteManager.
      await program.methods
        .initialize(tokenMint.publicKey, TOKEN_2022_PROGRAM_ID, new anchor.BN(100))
        .accounts(initializeAccounts)
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      // Assert that the error code corresponds to a double initialization attempt.
      expect(err.error.errorCode.code).to.equal("DoubleInitAttempt");
    }
  });

  /**
   * Test Case: Increment Round by Admin
   * Purpose: Ensure that the admin can successfully increment the voting round.
   */
  it("Increment Round by Admin", async () => {
    // Fetch the current voting round before incrementing.
    const voteManagerAccountBefore = await program.account.voteManager.fetch(voteManagerPda);
    const initialRound = voteManagerAccountBefore.voteRound;

    // Define the accounts required to increment the round.
    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    // Execute the round increment.
    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    // Fetch the voting round after incrementing.
    const voteManagerAccountAfter = await program.account.voteManager.fetch(voteManagerPda);

    // Assert that the voting round has been incremented by 1.
    expect(voteManagerAccountAfter.voteRound).to.equal(initialRound + 1);
  });

  /**
   * Test Case: Increment Round by Non-Admin
   * Purpose: Ensure that a non-admin user cannot increment the voting round.
   */
  it("Increment Round by Non-Admin", async () => {
    // Define the accounts for a non-admin attempting to increment the round.
    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: unauthorizedAttacker.publicKey,
    };

    try {
      // Attempt to increment the round using an unauthorized user.
      await program.methods
        .incrementRound()
        .accounts(incrementAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      // Assert that the error message includes "ConstraintSeeds", indicating seed constraints were violated.
      expect(err.message).to.include("ConstraintSeeds");
    }
  });

  /**
   * Test Case: Admin Changes Fee
   * Purpose: Verify that the admin can successfully change the voting fee.
   */
  it("Admin Changes Fee", async () => {
    // Fetch the current vote fee before changing it.
    const voteManagerAccountBefore = await program.account.voteManager.fetch(voteManagerPda);
    const initialFee = voteManagerAccountBefore.voteFee;

    // Define the new fee to be set by the admin.
    const newFee = new anchor.BN(500); // Update to 500 tokens as fee

    // Define the accounts required to change the fee.
    const changeFeeAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    // Execute the fee change.
    await program.methods
      .changeFee(newFee)
      .accounts(changeFeeAccounts)
      .rpc();

    // Fetch the vote fee after the change.
    const voteManagerAccountAfter = await program.account.voteManager.fetch(voteManagerPda);

    // Assert that the vote fee has been updated to the new value.
    expect(voteManagerAccountAfter.voteFee.toNumber()).to.equal(newFee.toNumber());

    // Assert that the vote fee has changed from its initial value.
    expect(voteManagerAccountAfter.voteFee.toNumber()).to.not.equal(initialFee.toNumber());
  });

  /**
   * Test Case: Non-Admin Tries to Change Fee
   * Purpose: Ensure that a non-admin user cannot change the voting fee.
   */
  it("Non-Admin Tries to Change Fee", async () => {
    // Define the new fee to be attempted by a non-admin.
    const newFee = new anchor.BN(500);

    // Define the accounts for the unauthorized fee change attempt.
    const changeFeeAccounts = {
      voteData: voteManagerPda,
      owner: unauthorizedAttacker.publicKey,
    };

    try {
      // Attempt to change the vote fee using an unauthorized user.
      await program.methods
        .changeFee(newFee)
        .accounts(changeFeeAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      // Assert that the error message includes "ConstraintSeeds", indicating seed constraints were violated.
      expect(err.message).to.include("ConstraintSeeds");
    }
  });

  /**
   * Test Case: Add Project with Unique idx
   * Purpose: Verify that adding a project with a unique identifier succeeds.
   */
  it("Add Project with Unique idx", async () => {
    // Define a unique project identifier.
    const uniqueProjectIdx = generateProjectIdx(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Derive the PDA for the unique project in round 2.
    const uniqueProjectPda = deriveProjectPda(uniqueProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add a new project.
    const addProjectAccounts = {
      projectData: uniqueProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Execute the project addition.
    await program.methods
      .addProject(uniqueProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    // Fetch the newly added project's account data.
    const projectAccount = await program.account.projectData.fetch(uniqueProjectPda);

    // Assertions to ensure the project was added correctly.
    expect(projectAccount.idx).to.equal(uniqueProjectIdx); // Project identifier should match.
    expect(projectAccount.voteCount.toNumber()).to.equal(0); // Initial vote count should be zero.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 2.
    expect(projectAccount.voteFee.toNumber()).to.equal(500); // Vote fee should reflect the current fee.
  });

  /**
   * Test Case: Add Project with Duplicate idx
   * Purpose: Ensure that adding a project with a duplicate identifier in the same round fails.
   */
  it("Add Project with Duplicate idx", async () => {
    // Define a duplicate project identifier.
    const duplicateProjectIdx = generateProjectIdx(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Derive the PDA for the duplicate project in round 2.
    const duplicateProjectPda = deriveProjectPda(duplicateProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the duplicate project.
    const addProjectAccounts = {
      projectData: duplicateProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // First addition of the duplicate project should succeed.
    await program.methods
      .addProject(duplicateProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    try {
      // Attempt to add the same project again in the same round.
      await program.methods
        .addProject(duplicateProjectIdx)
        .accounts(addProjectAccounts)
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      // Assert that the error message indicates the project identifier is already in use.
      expect(err.message).to.include("already in use");
    }
  });

  /**
   * Test Case: Reuse idx (project name) in a New Round
   * Purpose: Verify that a project identifier can be reused in a new voting round.
   */
  it("Reuse idx (project name) in a New Round", async () => {
    // Define the current voting round.
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Define a project identifier to be reused.
    const reusedProjectIdx = generateProjectIdx(10);

    // Derive the PDA for the reused project in round 3.
    const reusedProjectPda = deriveProjectPda(reusedProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the reused project.
    const addProjectAccounts = {
      projectData: reusedProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the reused project in round 3.
    await program.methods
      .addProject(reusedProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    // Fetch the added project's account data.
    const projectAccount = await program.account.projectData.fetch(reusedProjectPda);

    // Assertions to ensure the reused project was added correctly.
    expect(projectAccount.idx).to.equal(reusedProjectIdx); // Project identifier should match.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 3.
    expect(projectAccount.voteFee.toNumber()).to.equal(500); // Vote fee should reflect the current fee.
  });

  /**
   * Test Case: Double Voting Prevention
   * Purpose: Ensure that a voter cannot vote more than once in the same round.
   */
  // it("Double Voting Prevention", async () => {
  //   // Define the current voting round.

  //   const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
  //   const currentRound = voteManagerAccount.voteRound;;

  //   // Define a project identifier for double voting test.
  //   const doubleVoteProjectIdx = generateProjectIdx(10);

  //   // Derive the PDA for the double voting project in round 3.
  //   const doubleVoteProjectPda = deriveProjectPda(doubleVoteProjectIdx, currentRound, adminWallet.publicKey);

  //   // Define the accounts required to add the double voting project.
  //   const addProjectAccounts = {
  //     projectData: doubleVoteProjectPda,
  //     voteManager: voteManagerPda,
  //     owner: adminWallet.publicKey,
  //     systemProgram: anchor.web3.SystemProgram.programId,
  //   };

  //   // Add the double voting project to the VoteManager.
  //   await program.methods
  //     .addProject(doubleVoteProjectIdx)
  //     .accounts(addProjectAccounts)
  //     .rpc();

  //   // Define the accounts required to perform a vote.
  //   const doVoteAccounts = {
  //     vouterData: deriveVouterPda(currentRound, voter.publicKey), // Vouter PDA for the voter in round 3.
  //     signer: voter.publicKey, // Voter's public key.
  //     voteManager: voteManagerPda, // VoteManager PDA.
  //     adminTokenAccount: mintTokenAccount,
  //     project: doubleVoteProjectPda, // Project PDA being voted for.
  //     mint: tokenMint.publicKey, // Token mint's public key.
  //     token: voterAta, // Voter's token account.
  //     tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
  //     systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
  //   };

  //   // Perform the first vote by the voter.
  //   await program.methods
  //     .doVote(currentRound)
  //     .accounts(doVoteAccounts)
  //     .signers([voter])
  //     .rpc();

  //   try {
  //     // Attempt to perform a second vote by the same voter in the same round.
  //     await program.methods
  //       .doVote(currentRound)
  //       .accounts(doVoteAccounts)
  //       .signers([voter])
  //       .rpc();

  //     // If the above transaction succeeds, the test should fail.
  //     throw new Error("Expected transaction to fail, but it succeeded");
  //   } catch (err: any) {
  //     // Assert that the error message indicates the voter has already voted.
  //     expect(err.message).to.include("already in use");
  //   }
  // });

  // /**
  //  * Test Case: Voting in the Wrong Round
  //  * Purpose: Ensure that voting in a round different from the current active round fails.
  //  */
  it("Voting in the Wrong Round", async () => {
    // Define a project identifier for the wrong round voting test.
    const wrongRoundProjectIdx = generateProjectIdx(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Derive the PDA for the project intended for wrong round voting in round 3.
    const wrongRoundProjectPda = deriveProjectPda(wrongRoundProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the project.
    const addProjectAccounts = {
      projectData: wrongRoundProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the project to the VoteManager.
    await program.methods
      .addProject(wrongRoundProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    // Define the round number to attempt voting in, which is incorrect.
    const wrongVoteRound = 100;

    // Define the accounts required to perform a vote in the wrong round.
    const doVoteWrongRoundAccounts = {
      vouterData: deriveVouterPda(currentRound, voter.publicKey), // Derive with round 1, assuming current round is 3.
      signer: voter.publicKey, // Voter's public key.
      voteManager: voteManagerPda, // VoteManager PDA.
      adminTokenAccount: mintTokenAccount,
      project: wrongRoundProjectPda, // Project PDA being voted for.
      mint: tokenMint.publicKey, // Token mint's public key.
      token: voterAta, // Voter's token account.
      tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
    };

    try {
      // Attempt to vote in the wrong round by providing an incorrect round number.
      await program.methods
        .doVote(wrongVoteRound) // Incorrect round number.
        .accounts(doVoteWrongRoundAccounts)
        .signers([voter])
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err) {
      // Assert that the error message indicates voting in the wrong round.
      expect(err.message).to.include("ConstraintSeeds"); // Adjusted based on actual error handling.
    }
  });

  // /**
  //  * Test Case: Voting Fee Transfer
  //  * Purpose: Verify that the voting fee is correctly transferred from the voter to the admin upon voting.
  //  */
  it("Voting Fee Transfer", async () => {
    // Define a project identifier for the fee transfer test.

    // Define the accounts required to increment the round.
    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    // Execute the round increment.
    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    const feeTransferProjectIdx = generateProjectIdx(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;

    const feeTransferProjectPda = deriveProjectPda(feeTransferProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the fee transfer project.
    const addProjectAccounts = {
      projectData: feeTransferProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the fee transfer project to the VoteManager.
    await program.methods
      .addProject(feeTransferProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    // Define the accounts required to perform a vote.
    const doVoteAccounts = {
      vouterData: deriveVouterPda(currentRound, voter.publicKey),
      signer: voter.publicKey, // Voter's public key.
      voteManager: voteManagerPda, // VoteManager PDA.
      adminTokenAccount: mintTokenAccount,
      project: feeTransferProjectPda, // Project PDA being voted for.
      mint: tokenMint.publicKey, // Token mint's public key.
      token: voterAta, // Voter's token account.
      tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
    };

    // Fetch the voter's and admin's initial token balances before voting.
    const initialVoterBalance = await getTokenBalance(provider.connection, voterAta);
    const initialAdminBalance = await getTokenBalance(provider.connection, mintTokenAccount);

    // Perform the vote, which should transfer the vote fee from the voter to the admin.
    await program.methods
      .doVote(currentRound)
      .accounts(doVoteAccounts)
      .signers([voter])
      .rpc();

    // Fetch the voter's and admin's token balances after voting.
    const finalVoterBalance = await getTokenBalance(provider.connection, voterAta);
    const finalAdminBalance = await getTokenBalance(provider.connection, mintTokenAccount);

    // Assert that the voter's balance decreased by the vote fee amount (500 TTT).
    expect(finalVoterBalance).to.equal(initialVoterBalance - voteManagerAccount.voteFee.toNumber());

    // Assert that the admin's balance increased by the vote fee amount (500 TTT).
    expect(finalAdminBalance).to.equal(initialAdminBalance + voteManagerAccount.voteFee.toNumber());
  });

  // /**
  //  * Test Case: Successful Vote
  //  * Purpose: Verify that a valid vote correctly updates the project's vote count and the voter's voting data.
  //  */
  it("Successful Vote", async () => {
    // Define a project identifier for the successful vote test.
    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    const successfulVoteProjectIdx = generateProjectIdx(10);
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    const successfulVoteProjectPda = deriveProjectPda(successfulVoteProjectIdx, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the successful vote project.
    const addProjectAccounts = {
      projectData: successfulVoteProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the successful vote project to the VoteManager.
    await program.methods
      .addProject(successfulVoteProjectIdx)
      .accounts(addProjectAccounts)
      .rpc();

    // Define the accounts required to perform a vote.
    const doVoteAccounts = {
      vouterData: deriveVouterPda(currentRound, voter.publicKey), // Vouter PDA for the voter in round 5.
      signer: voter.publicKey, // Voter's public key.
      voteManager: voteManagerPda, // VoteManager PDA.
      adminTokenAccount: mintTokenAccount,
      project: successfulVoteProjectPda, // Project PDA being voted for.
      mint: tokenMint.publicKey, // Token mint's public key.
      token: voterAta, // Voter's token account.
      tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
    };

    // Perform the vote, which should update the project's vote count and voter's data.
    await program.methods
      .doVote(currentRound)
      .accounts(doVoteAccounts)
      .signers([voter])
      .rpc();

    // Fetch the project's account data after the vote.
    const projectAccount = await program.account.projectData.fetch(successfulVoteProjectPda);

    // Fetch the voter's voting data after the vote.
    const voterAccount = await program.account.vouterData.fetch(doVoteAccounts.vouterData);

    // Assertions to ensure the vote was successfully recorded.
    expect(projectAccount.idx).to.equal(successfulVoteProjectIdx); // Project identifier should match.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 5.
    expect(projectAccount.voteCount.toNumber()).to.be.greaterThan(0); // Project's vote count should have increased.

    expect(voterAccount.voteCount.toNumber()).to.be.greaterThan(0); // Voter's vote count should have increased.
    expect(voterAccount.lastVotedRound).to.equal(currentRound);
  });
});

// -------------------- End of Test Suite --------------------
