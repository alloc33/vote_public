# TTT Token Project

Available commands to test:
```shell
Devnet:

$ just add-project <project_key> <round> # Add a project to a voting round
$ just change-fee <new_fee>              # Change the voting fee
$ just do-vote <project_key> <round>     # Cast a vote for a project in a specific round
$ just get-round                         # Get the current voting round
$ just help                              # Utility to print available commands
$ just increment-round                   # Increment the current voting round
$ just init-force                        # Initialize the VoteManager forcefully
```
This project consists of two Solana programs:

## Governance Program
- Manages voting logic and processes.
- Key responsibilities:
  - Voting round initialization and increments.
  - Project registration for voting.
  - TTT token-based voting system.

## TTT Token Program
- Implements the **TTT token** using Solana's Token-2022 standard.
- Key responsibilities:
  - Creates the TTT token mint with an initial supply of **450 million tokens**.
  - Automatically mints the entire supply to the admin's associated token account during token creation.

## Key Features
- **Governance**:
  - Admin-controlled voting manager.
  - Projects and voting tied to specific rounds.
  - Transparent, token-based voting system.
  
- **Token**:
  - Token-2022 compatibility with enhanced extensions.
  - Automatic metadata and authority management.
  - Fixed total supply, ensuring no further minting.

