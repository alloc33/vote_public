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

// Define the initial supply of the ttt token.
const ttt_TOKEN_INITIAL_SUPPLY = 450_000_000;

// Namespace used for deriving Voter PDAs. Helps in organizing related accounts.
const VOTER_NAMESPACE = "voter";

// Default amount of SOL to airdrop to test accounts to cover transaction fees.
const DEFAULT_AIRDROP_SOL = 1;

const EXTRA_ACCOUNT_METAS = "extra-account-metas";

// -------------------- Helper Functions --------------------

/**
 * Derives a Project PDA based on project index, round, and admin public key.
 * @param projectId - Unique identifier for the project.
 * @param round - Current voting round.
 * @param adminPubkey - Admin's public key.
 * @returns PublicKey of the Project PDA.
 */
function deriveProjectPda(projectId: string, round: number, adminPubkey: PublicKey): PublicKey {
  // Use a single-byte buffer for the round number as per the original logic.
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(projectId),
      Buffer.from([round]), // 1-byte round number without padding
      adminPubkey.toBuffer(),
    ],
    program.programId
  )[0];
}

/**
 * Derives a Voter PDA based on round and voter's public key.
 * @param round - Current voting round.
 * @param voterPubkey - Voter's public key.
 * @returns PublicKey of the Voter PDA.
 */
function deriveVoterPda(round: number, voterPubkey: PublicKey, projectId: string): PublicKey {
  // Use a 6-byte buffer with padding as per the original logic.
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(VOTER_NAMESPACE),
      Buffer.from([round, 1, 1, 1, 1]), // 1-byte round number with 5-byte padding
      voterPubkey.toBuffer(),
      Buffer.from(projectId),
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
function generateProjectId(length = 20): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Usage:
const doubleVoteProjectId = generateProjectId(20);
console.log(doubleVoteProjectId); // e.g. "aB3xYz12WpQ9..." (20 random chars)
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
  let voterA: Keypair; // Keypair representing a voter.
  let voterAAta: PublicKey; // Associated Token Account for the voter.
  let voterB: Keypair; // Keypair representing a voter.
  let voterBAta: PublicKey; // Associated Token Account for the voter.
  let insufficientUser: Keypair; // Associated Token Account for the voter.
  let mintTokenAccount: PublicKey; // Token account holding the minted tokens.
  let adminWallet: anchor.Wallet; // Admin's wallet, used to sign transactions.
  let admin: Keypair; // Keypair corresponding to the admin's wallet.
  let voteManagerPda: PublicKey; // PDA for managing voting rounds and projects.
  let extraMetasAccount: PublicKey; // Additional metadata account PDA.
  let projectId: string; // Identifier for a specific project.
  let unauthorizedAttacker: Keypair; // Keypair representing an unauthorized user attempting actions.

  // -------------------- Hooks --------------------
  before(async () => {
    try {
      // Setup initial values..
      tokenMint = Keypair.generate();
      voterA = Keypair.generate();
      voterB = Keypair.generate();
      insufficientUser = Keypair.generate();
      adminWallet = provider.wallet as anchor.Wallet;
      admin = adminWallet.payer;
      unauthorizedAttacker = Keypair.generate();

      // Derive the VoteManager PDA using the "vote_manager" seed and admin's public key.
      voteManagerPda = PublicKey.findProgramAddressSync(
        [Buffer.from("vote_manager"), adminWallet.publicKey.toBuffer()],
        program.programId
      )[0];

      // Define a project identifier.
      projectId = "projectVote1";

      // Derive the extraMetasAccount PDA using specific seeds.
      extraMetasAccount = PublicKey.findProgramAddressSync(
        [
          Buffer.from(EXTRA_ACCOUNT_METAS),
          tokenMint.publicKey.toBuffer(),
        ],
        tokenProgram.programId
      )[0];

      console.log("\nPerforming necessary airdrops...\n");

      // Airdrop SOL to the voter and unauthorized attacker to ensure they can cover transaction fees.
      await airdropIfNeeded(provider.connection, voterA.publicKey, DEFAULT_AIRDROP_SOL);
      await airdropIfNeeded(provider.connection, voterB.publicKey, DEFAULT_AIRDROP_SOL);
      await airdropIfNeeded(provider.connection, unauthorizedAttacker.publicKey, DEFAULT_AIRDROP_SOL);
      await airdropIfNeeded(provider.connection, insufficientUser.publicKey, DEFAULT_AIRDROP_SOL);

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
          symbol: "ttt", // Symbol for the token.
          uri: "https://my-token-data.com/metadata.json", // URI pointing to token metadata.
          initialSupply: new anchor.BN(ttt_TOKEN_INITIAL_SUPPLY), // Initial supply of the token.
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
      voterAAta = await getAssociatedTokenAddress(
        tokenMint.publicKey,
        voterA.publicKey,
        true, // Allow PDA derivation.
        TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
        ASSOCIATED_PROGRAM_ID // Associated Token program ID.
      );

      voterBAta = await getAssociatedTokenAddress(
        tokenMint.publicKey,
        voterB.publicKey,
        true, // Allow PDA derivation.
        TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
        ASSOCIATED_PROGRAM_ID // Associated Token program ID.
      );

      // Check if the voter's ATA already exists to avoid unnecessary transactions.
      const ataAccount1 = await provider.connection.getAccountInfo(voterAAta);
      const ataAccount2 = await provider.connection.getAccountInfo(voterBAta);
      if (!ataAccount1) {
        // If ATA doesn't exist, create it.
        const ataTransaction = new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            provider.publicKey, // Payer of the transaction fees.
            voterAAta,           // PDA address for the ATA.
            voterA.publicKey,    // Owner of the ATA.
            tokenMint.publicKey,// Token mint for the ATA.
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_PROGRAM_ID
          )
        );

        await provider.sendAndConfirm(ataTransaction); // Send and confirm the ATA creation transaction.
        console.log("Voter A ATA created.");
      } else {
        console.log(`ATA for ${voterA.publicKey.toBase58()} already exists.`);
      }

      if (!ataAccount2) {
        // If ATA doesn't exist, create it.
        const ataTransaction = new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            provider.publicKey, // Payer of the transaction fees.
            voterBAta,           // PDA address for the ATA.
            voterB.publicKey,    // Owner of the ATA.
            tokenMint.publicKey,// Token mint for the ATA.
            TOKEN_2022_PROGRAM_ID,
            ASSOCIATED_PROGRAM_ID
          )
        );

        await provider.sendAndConfirm(ataTransaction); // Send and confirm the ATA creation transaction.
        console.log("Voter B ATA created.");
      } else {
        console.log(`ATA for ${voterB.publicKey.toBase58()} already exists.`);
      }

      // Define the accounts involved in transferring ttt tokens from the mint to the voter.
      const transferAccounts1 = {
        fromAta: mintTokenAccount, // Source ATA holding the minted tokens.
        toAta: voterAAta,           // Destination ATA to receive tokens.
        mint: tokenMint.publicKey, // Token mint associated with the transfer.
        tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      };

      const transferAccounts2 = {
        fromAta: mintTokenAccount, // Source ATA holding the minted tokens.
        toAta: voterBAta,           // Destination ATA to receive tokens.
        mint: tokenMint.publicKey, // Token mint associated with the transfer.
        tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      };

      // Execute the token transfer of 10,000 ttt from admin to voter A.
      await tokenProgram.methods
        .transferTokens(new anchor.BN(10_000)) // Amount of ttt tokens to transfer.
        .accounts(transferAccounts1)
        .signers([admin]) // Admin signs the transaction.
        .rpc();

      // Execute the token transfer of 10,000 ttt from admin to voter B.
      await tokenProgram.methods
        .transferTokens(new anchor.BN(10_000)) // Amount of ttt tokens to transfer.
        .accounts(transferAccounts2)
        .signers([admin]) // Admin signs the transaction.
        .rpc();

      console.log("ttt tokens transferred to test voter.");
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
   * Test Case: Add Project with Unique id
   * Purpose: Verify that adding a project with a unique identifier succeeds.
   */
  it("Add Project with Unique id", async () => {
    // Define a unique project identifier.
    const uniqueProjectId = generateProjectId(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Derive the PDA for the unique project in round 2.
    const uniqueProjectPda = deriveProjectPda(uniqueProjectId, currentRound, adminWallet.publicKey);

    // Define the accounts required to add a new project.
    const addProjectAccounts = {
      projectData: uniqueProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Execute the project addition.
    await program.methods
      .addProject(uniqueProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    // Fetch the newly added project's account data.
    const projectAccount = await program.account.projectData.fetch(uniqueProjectPda);

    // Assertions to ensure the project was added correctly.
    expect(projectAccount.id).to.equal(uniqueProjectId); // Project identifier should match.
    expect(projectAccount.voteCount.toNumber()).to.equal(0); // Initial vote count should be zero.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 2.
    expect(voteManagerAccount.voteFee.toNumber() == 500);
  });

  /**
   * Test Case: Add Project with Duplicate id
   * Purpose: Ensure that adding a project with a duplicate identifier in the same round fails.
   */
  it("Add Project with Duplicate id", async () => {
    // Define a duplicate project identifier.
    const duplicateProjectId = generateProjectId(10);

    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    // Derive the PDA for the duplicate project in round 2.
    const duplicateProjectPda = deriveProjectPda(duplicateProjectId, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the duplicate project.
    const addProjectAccounts = {
      projectData: duplicateProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // First addition of the duplicate project should succeed.
    await program.methods
      .addProject(duplicateProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    try {
      // Attempt to add the same project again in the same round.
      await program.methods
        .addProject(duplicateProjectId)
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
   * Test Case: Reuse id (project name) in a New Round
   * Purpose: Verify that a project identifier can be reused in a new voting round.
   */
  it("Reuse id (project name) in a New Round", async () => {
    // Define the current voting round.
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;

    // Define a project identifier to be reused.
    const reusedProjectId = generateProjectId(10);

    // Derive the PDA for the reused project in round 3.
    const reusedProjectPda = deriveProjectPda(reusedProjectId, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the reused project.
    const addProjectAccounts = {
      projectData: reusedProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the reused project in round 3.
    await program.methods
      .addProject(reusedProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    // Fetch the added project's account data.
    const projectAccount = await program.account.projectData.fetch(reusedProjectPda);

    // Assertions to ensure the reused project was added correctly.
    expect(projectAccount.id).to.equal(reusedProjectId); // Project identifier should match.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 3.
    expect(voteManagerAccount.voteFee.toNumber() == 500);
  });

  /**
   * Test Case: Voting in the Wrong Round
   * Purpose: Ensure that voting in a round different from the current active round fails.
   * 
   * ! We use project id as a part of voter's seed - Anchor treats wrong round errors as constraint violation errors in this case.
   */
  it("Voting in the Wrong Round", async () => {

    // const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const wrongRound = 123;
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;
    // Define a project identifier for the wrong round voting test.
    const projectId = generateProjectId(10);

    // Derive the PDA for the project intended for wrong round voting in round 3.
    const projectPda = deriveProjectPda(projectId, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the project.
    const addProjectAccounts = {
      projectData: projectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the project to the VoteManager.
    await program.methods
      .addProject(projectId)
      .accounts(addProjectAccounts)
      .rpc();

    // Define the accounts required to perform a vote in the wrong round.
    const doVoteWrongRoundAccounts = {
      voterData: deriveVoterPda(wrongRound, voterA.publicKey, projectId), // Derive with round 1, assuming current round is 3.
      signer: voterA.publicKey, // Voter's public key.
      voteManager: voteManagerPda, // VoteManager PDA.
      adminTokenAccount: mintTokenAccount,
      project: projectPda, // Project PDA being voted for.
      mint: tokenMint.publicKey, // Token mint's public key.
      token: voterAAta, // Voter's token account.
      tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
    };

    try {
      // Attempt to vote in the wrong round by providing an incorrect round number.
      await program.methods
        .doVote()
        .accounts(doVoteWrongRoundAccounts)
        .signers([voterA])
        .rpc();

      // If the above transaction succeeds, the test should fail.
      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ConstraintSeeds");
    }
  });

  /**
   * Test Case: Successful Vote + fee transfer
   * Purpose: Verify that a valid vote correctly updates the project's vote count and the voter's voting data.
   */
  it("Successful Vote, fee transfer", async () => {
    // Define a project identifier for the successful vote test.
    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    const successfulVoteProjectId = generateProjectId(10);
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;;

    const successfulVoteProjectPda = deriveProjectPda(successfulVoteProjectId, currentRound, adminWallet.publicKey);

    // Define the accounts required to add the successful vote project.
    const addProjectAccounts = {
      projectData: successfulVoteProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the successful vote project to the VoteManager.
    await program.methods
      .addProject(successfulVoteProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    // Define the accounts required to perform a vote.
    const doVoteAccounts = {
      voterData: deriveVoterPda(currentRound, voterA.publicKey, successfulVoteProjectId), // Voter PDA for the voter in round 5.
      signer: voterA.publicKey, // Voter's public key.
      voteManager: voteManagerPda, // VoteManager PDA.
      adminTokenAccount: mintTokenAccount,
      project: successfulVoteProjectPda, // Project PDA being voted for.
      mint: tokenMint.publicKey, // Token mint's public key.
      token: voterAAta, // Voter's token account.
      tokenProgram: TOKEN_2022_PROGRAM_ID, // SPL Token program ID.
      systemProgram: anchor.web3.SystemProgram.programId, // System program ID.
    };

    // Fetch the voter's and admin's initial token balances before voting.
    const initialVoterBalance = await getTokenBalance(provider.connection, voterAAta);
    const initialAdminBalance = await getTokenBalance(provider.connection, mintTokenAccount);
    // Perform the vote, which should update the project's vote count and voter's data.
    await program.methods
      .doVote()
      .accounts(doVoteAccounts)
      .signers([voterA])
      .rpc();

    // Fetch the voter's and admin's token balances after voting.
    const finalVoterBalance = await getTokenBalance(provider.connection, voterAAta);
    const finalAdminBalance = await getTokenBalance(provider.connection, mintTokenAccount);

    // Fetch the project's account data after the vote.
    const projectAccount = await program.account.projectData.fetch(successfulVoteProjectPda);

    // Fetch the voter's voting data after the vote.
    const voterAccount = await program.account.voterData.fetch(doVoteAccounts.voterData);

    // Assertions to ensure the vote was successfully recorded.
    expect(projectAccount.id).to.equal(successfulVoteProjectId); // Project identifier should match.
    expect(projectAccount.voteRound).to.equal(currentRound); // Project should be associated with round 5.
    expect(projectAccount.voteCount.toNumber()).to.be.greaterThan(0); // Project's vote count should have increased.

    expect(voterAccount.voteCount.toNumber()).to.be.greaterThan(0); // Voter's vote count should have increased.
    expect(voterAccount.lastVotedRound).to.equal(currentRound);

    // Assert that the voter's balance decreased by the vote fee amount (500 ttt).
    expect(finalVoterBalance).to.equal(initialVoterBalance - voteManagerAccount.voteFee.toNumber());

    // Assert that the admin's balance increased by the vote fee amount (500 ttt).
    expect(finalAdminBalance).to.equal(initialAdminBalance + voteManagerAccount.voteFee.toNumber());
  });

  /**
   * Test Case: Multiple users voting on the same project in the same round
   * Purpose: Ensure vote count stored properly per project
   */
  it("Multiple users voting on the same project in the same round", async () => {
    // Create a unique project
    const multiUserProjectId = generateProjectId(10);
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;

    const multiUserProjectPda = deriveProjectPda(multiUserProjectId, currentRound, adminWallet.publicKey);

    const addProjectAccounts = {
      projectData: multiUserProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add the project
    await program.methods
      .addProject(multiUserProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    // userA votes
    const doVoteAccountsUserA = {
      voterData: deriveVoterPda(currentRound, voterA.publicKey, multiUserProjectId),
      signer: voterA.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: multiUserProjectPda,
      mint: tokenMint.publicKey,
      token: voterAAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };
    await program.methods.doVote().accounts(doVoteAccountsUserA).signers([voterA]).rpc();

    // userB votes
    const doVoteAccountsUserB = {
      voterData: deriveVoterPda(currentRound, voterB.publicKey, multiUserProjectId),
      signer: voterB.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: multiUserProjectPda,
      mint: tokenMint.publicKey,
      token: voterBAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    await program.methods.doVote().accounts(doVoteAccountsUserB).signers([voterB]).rpc();

    // Check final result
    const projectAccount = await program.account.projectData.fetch(multiUserProjectPda);
    expect(projectAccount.voteCount.toNumber()).to.equal(2, "Project should have 2 total votes");
  });

  /**
   * Test Case: Insufficient tokens for voting fee should fail
   * Purpose: Ensure that user has enough ttt to vote
   */
  it("Insufficient tokens for voting fee should fail", async () => {
    const insufficientProjectId = generateProjectId(10);
    const voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const currentRound = voteManagerAccount.voteRound;

    const insufficientProjectPda = deriveProjectPda(insufficientProjectId, currentRound, adminWallet.publicKey);

    const addProjectAccounts = {
      projectData: insufficientProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add a project
    await program.methods
      .addProject(insufficientProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    // Create a user with no ttt tokens
    const insufficientUserAta = await getAssociatedTokenAddress(
      tokenMint.publicKey,
      insufficientUser.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ataTransaction = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        provider.publicKey,
        insufficientUserAta,
        insufficientUser.publicKey,
        tokenMint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(ataTransaction); // Send and confirm the ATA creation transaction.

    // (No token transfer from admin, so user has 0 ttt)

    // Attempt to vote
    const doVoteAccounts = {
      voterData: deriveVoterPda(currentRound, insufficientUser.publicKey, insufficientProjectId),
      signer: insufficientUser.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: insufficientProjectPda,
      mint: tokenMint.publicKey,
      token: insufficientUserAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      await program.methods
        .doVote()
        .accounts(doVoteAccounts)
        .signers([insufficientUser])
        .rpc();

      throw new Error("Expected InsufficientTokens error, but transaction succeeded.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientTokens");
    }
  });

  /**
   * Test Case: Voting on a previous round's project fails with WrongRound
   * Purpose: Ensure that user is unable to vote for project from other rounds.
   */
  it("Voting on a previous round's project fails with WrongRound", async () => {
    // 1) Add a project in round1
    let voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const oldRound = voteManagerAccount.voteRound;
    const oldRoundProjectId = generateProjectId(10);
    const oldRoundProjectPda = deriveProjectPda(oldRoundProjectId, oldRound, adminWallet.publicKey);

    const addProjectAccounts = {
      projectData: oldRoundProjectPda,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    await program.methods
      .addProject(oldRoundProjectId)
      .accounts(addProjectAccounts)
      .rpc();

    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    // 2) Increment the round
    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    // The project is from the old round. Let's attempt to vote:
    const doVoteAccounts = {
      voterData: deriveVoterPda(oldRound, voterA.publicKey, oldRoundProjectId),
      signer: voterA.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: oldRoundProjectPda,
      mint: tokenMint.publicKey,
      token: voterAAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      await program.methods.doVote().accounts(doVoteAccounts).signers([voterA]).rpc();
      throw new Error("Expected WrongRound error, but transaction succeeded.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("WrongRound");
    }
  });

  /**
   * Test Case: User votes in two consecutive rounds successfully
   * Purpose: Ensure successfull consecutive voting.
   */
  it("User votes in two consecutive rounds successfully", async () => {
    // Round #1
    let voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const round1 = voteManagerAccount.voteRound;
    const projectIdRound1 = generateProjectId(10);
    const pdaProjectRound1 = deriveProjectPda(projectIdRound1, round1, adminWallet.publicKey);

    const addProjectAccounts = {
      projectData: pdaProjectRound1,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add project for Round 1
    await program.methods
      .addProject(projectIdRound1)
      .accounts(addProjectAccounts)
      .rpc();

    // Do Vote in Round 1
    const doVoteAccountsRound1 = {
      voterData: deriveVoterPda(round1, voterA.publicKey, projectIdRound1),
      signer: voterA.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: pdaProjectRound1,
      mint: tokenMint.publicKey,
      token: voterAAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };
    await program.methods.doVote().accounts(doVoteAccountsRound1).signers([voterA]).rpc();

    const incrementAccounts = {
      voteData: voteManagerPda,
      owner: adminWallet.publicKey,
    };

    // Increment Round
    await program.methods
      .incrementRound()
      .accounts(incrementAccounts)
      .rpc();

    voteManagerAccount = await program.account.voteManager.fetch(voteManagerPda);
    const round2 = voteManagerAccount.voteRound;
    const projectIdRound2 = generateProjectId(10);
    const pdaProjectRound2 = deriveProjectPda(projectIdRound2, round2, adminWallet.publicKey);

    const addProjectAccounts1 = {
      projectData: pdaProjectRound2,
      voteManager: voteManagerPda,
      owner: adminWallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Add project for Round 2
    await program.methods
      .addProject(projectIdRound2)
      .accounts(addProjectAccounts1)
      .rpc();

    // Do Vote in Round 2
    const doVoteAccountsRound2 = {
      voterData: deriveVoterPda(round2, voterA.publicKey, projectIdRound2),
      signer: voterA.publicKey,
      voteManager: voteManagerPda,
      adminTokenAccount: mintTokenAccount,
      project: pdaProjectRound2,
      mint: tokenMint.publicKey,
      token: voterAAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };
    await program.methods.doVote().accounts(doVoteAccountsRound2).signers([voterA]).rpc();

    // Validate results for Round 1 and Round 2
    const projectRound1 = await program.account.projectData.fetch(pdaProjectRound1);
    const projectRound2 = await program.account.projectData.fetch(pdaProjectRound2);
    expect(projectRound1.voteCount.toNumber()).to.equal(1, "Round 1 project has 1 vote");
    expect(projectRound2.voteCount.toNumber()).to.equal(1, "Round 2 project has 1 vote");
  });
});

// -------------------- End of Test Suite --------------------
