# Justfile for TTT Token CLI

# Constants
cli := "cargo run --bin ttt-cli --release"
env_path := "~/.config/solana"

_default:
    just --list

# Initialize the VoteManager forcefully
init-force:
    {{cli}} init_force

# Add a project to a voting round
add-project project_key round:
    {{cli}} add_project {{project_key}} {{round}}

# Change the voting fee
change-fee new_fee:
    {{cli}} change_fee {{new_fee}}

# Get the current voting round
get-round:
    {{cli}} get_round

# Increment the current voting round
increment-round:
    {{cli}} increment_round

# Cast a vote for a project in a specific round
do-vote project_name round:
    {{cli}} do_vote {{project_name}} {{round}}

# Utility to print available commands
help:
    just --list
