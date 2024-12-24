use std::{env, error::Error, rc::Rc};

use anchor_client::{
    solana_sdk::{pubkey::Pubkey, signature::read_keypair_file, system_program},
    Client, Cluster,
};

use anchor_client::{
    solana_client::{
        client_error::ClientErrorKind::RpcError,
        rpc_request::{RpcError as SolanaRpcError, RpcResponseErrorData},
    },
    solana_sdk::signature::{Keypair, Signer},
    ClientError::SolanaClientError,
};

const ADMIN_SECRET: &str = "";
const GOVERNANCE_PROGRAM_ID: &str = "";
const TOKEN_MINT: &str = "";
const VOUTER_SECRET: &str = "";
const TOKEN_PROGRAM: &str = "";
const ASSOCIATED_TOKEN_PROGRAM: &str = "";

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  {} init_force", args[0]);
        eprintln!("  {} add_project <project_key> <round>", args[0]);
        eprintln!("  {} change_fee <new_fee>", args[0]);
        eprintln!("  {} get_round", args[0]);
        eprintln!("  {} increment_round", args[0]);
        eprintln!("  {} do_vote  <project_name> <round>", args[0]);
        return Ok(());
    }

    match args[1].as_str() {
        "init_force" => init_force().await?,
        "change_fee" => {
            if args.len() < 3 {
                eprintln!("Usage: {} change_fee <new_fee>", args[0]);
                return Ok(());
            }
            let new_fee = args[2].parse::<u64>()?;
            change_fee(new_fee).await?;
        }
        "get_round" => {
            get_round().await?;
        }
        "increment_round" => {
            increment_round().await?;
        }
        "add_project" => {
            if args.len() < 4 {
                eprintln!("Usage: {} add_project <project_key> <round>", args[0]);
                return Ok(());
            }
            let project_key = &args[2];
            let round = &args[3];
            add_project(project_key, round.parse().unwrap()).await?;
        }
        "do_vote" => {
            if args.len() < 4 {
                eprintln!("Usage: {} do_vote  <project_name> <round>", args[0]);
                return Ok(());
            }
            let project_key = &args[2];
            let round = args[3].parse::<u8>()?;
            do_vote(project_key, round).await?;
        }
        other => {
            eprintln!("Unknown command: {}", other);
        }
    }

    Ok(())
}

async fn init_force() -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;
    let cluster = Cluster::Devnet;
    let payer = Rc::new(keypair);
    let client = Client::new(cluster, payer.clone());
    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_data_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let send_res = program
        .request()
        .accounts(governance::accounts::Admin {
            vote_data: vote_data_pda,
            owner: program.payer(),
            system_program: system_program::ID,
        })
        .args(governance::instruction::InitializeForce {
            token_mint: TOKEN_MINT.parse()?,
            token_program: TOKEN_PROGRAM.parse()?,
            init_vote_fee: 100,
        })
        .signer(&*payer)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Success! Transaction signature: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    Ok(())
}

async fn change_fee(new_fee: u64) -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;

    let cluster = Cluster::Devnet;

    let payer = Rc::new(keypair);
    let client = Client::new(cluster, payer.clone());

    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_data_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let send_res = program
        .request()
        .accounts(governance::accounts::Admin {
            vote_data: vote_data_pda,
            owner: program.payer(),
            system_program: system_program::ID,
        })
        .args(governance::instruction::ChangeFee {
            new_vote_fee: new_fee,
        })
        .signer(&*payer)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Success! Fee changed. Tx signature: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    Ok(())
}

async fn get_round() -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;

    let cluster = Cluster::Devnet;

    let payer = Rc::new(keypair);
    let client = Client::new(cluster, payer.clone());

    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_data_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let vote_manager: governance::governance::VoteManager = program.account(vote_data_pda).await?;
    let current_round = vote_manager.vote_round;

    println!("Current round: {current_round}");

    Ok(())
}

async fn increment_round() -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;

    let cluster = Cluster::Devnet;

    let payer = Rc::new(keypair);
    let client = Client::new(cluster, payer.clone());

    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_data_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let send_res = program
        .request()
        .accounts(governance::accounts::Admin {
            vote_data: vote_data_pda,
            owner: program.payer(),
            system_program: system_program::ID,
        })
        .args(governance::instruction::IncrementRound)
        .signer(&*payer)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Success! Round incremented. Tx signature: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    Ok(())
}

async fn add_project(project_key: &str, round: u8) -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;
    let cluster = Cluster::Devnet;
    let payer = Rc::new(keypair);
    let client = Client::new(cluster, payer.clone());

    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_data_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let (project_data_pda, _project_bump) =
        derive_project_pda(project_key, round, &program.payer(), &program.id());

    let send_res = program
        .request()
        .accounts(governance::accounts::NewVoteProject {
            project_data: project_data_pda,
            vote_manager: vote_data_pda,
            owner: program.payer(),
            system_program: system_program::ID,
        })
        .args(governance::instruction::AddProject {
            idx: project_key.to_owned(),
        })
        .signer(&*payer)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Success! Project added. Tx signature: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    Ok(())
}

async fn do_vote(
    project_key: &str,
    round: u8,
) -> Result<(), Box<dyn Error>> {
    let keypair = get_keypair(ADMIN_SECRET)?;
    let mint = "GgQuhpBUxy7LaD56c2vbxk5hSgoBuNwxxev6U9iqyMXZ".parse::<Pubkey>()?;
    let vouter_keypair = get_keypair(VOUTER_SECRET)?;

    let cluster = Cluster::Devnet;
    let payer = Rc::new(keypair);
    let vouter = Rc::new(vouter_keypair);
    let client = Client::new(cluster, payer.clone());

    let governance_program_pubkey = GOVERNANCE_PROGRAM_ID.parse::<Pubkey>()?;
    let program = client.program(governance_program_pubkey)?;

    let (vote_manager_pda, _) = derive_vote_manager_pda(&program.payer(), &program.id());

    let (vouter_pda, _) = derive_vouter_pda(round, &vouter.pubkey(), &program.id());

    let (project_data_pda, _project_bump) =
        derive_project_pda(project_key, round, &program.payer(), &program.id());

    let admin_token_account =
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &program.payer(),
            &mint,
            &TOKEN_PROGRAM.parse::<Pubkey>()?,
        );

    let vouter_ata = anchor_spl::associated_token::get_associated_token_address_with_program_id(
        &vouter.pubkey(),
        &mint,
        &TOKEN_PROGRAM.parse::<Pubkey>()?,
    );

    let vote_manager: governance::governance::VoteManager = program.account(vote_manager_pda).await?;
    let vote_fee = vote_manager.vote_fee;

    println!("Payer Pubkey: {}", payer.pubkey());
    println!("Mint Pubkey: {}", mint);
    println!("Admin Token Account: {}", admin_token_account);
    println!("Vouter ATA: {}", vouter_ata);

    let send_res = program
        .request()
        .accounts(governance::accounts::EnsureCanVote {
            signer: vouter.pubkey(),
            admin_token_account,
            admin_authority: payer.pubkey(),
            mint,
            user_ata: vouter_ata,
            token_program: TOKEN_PROGRAM.parse::<Pubkey>()?,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM.parse::<Pubkey>()?,
            system_program: system_program::ID,
        })
        .args(governance::instruction::EnsureUserCanVote {
            vote_fee,
            guard: "__granted_access_by__cli".to_owned(),
        }) 
        .signer(&*vouter)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Ensured can vote: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    let send_res = program
        .request()
        .accounts(governance::accounts::Vouter {
            vouter_data: vouter_pda,
            signer: vouter.pubkey(),
            vote_manager: vote_manager_pda,
            admin_token_account,
            project: project_data_pda,
            mint,
            token: vouter_ata,
            token_program: TOKEN_PROGRAM.parse::<Pubkey>()?,
            system_program: system_program::ID,
        })
        .args(governance::instruction::DoVote { round })
        .signer(&*vouter)
        .send()
        .await;

    match send_res {
        Ok(sig) => println!("Success! Vote casted. Tx signature: {sig}"),
        Err(e) => print_transaction_logs(&e),
    }

    Ok(())
}

fn derive_vouter_pda(round: u8, vouter_pubkey: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"vouter",
            &[round, 1, 1, 1, 1, 1],
            &vouter_pubkey.to_bytes(),
        ],
        program_id,
    )
}

fn derive_project_pda(
    project_key: &str,
    round: u8,
    admin_pubkey: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            project_key.as_bytes(),
            &[round],
            &admin_pubkey.to_bytes(),
        ],
        program_id,
    )
}

fn derive_vote_manager_pda(admin_pubkey: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"vote_manager",
            &admin_pubkey.to_bytes(),
        ],
        program_id,
    )
}

fn get_keypair(str: &str) -> Result<Keypair, Box<dyn Error>> {
    let file = String::from_utf8(tilde_expand::tilde_expand(str.as_bytes()))?;
    read_keypair_file(file)
}

fn print_transaction_logs(e: &anchor_client::ClientError) {
    if let SolanaClientError(solana_err) = e {
        if let RpcError(SolanaRpcError::RpcResponseError { data, .. }) = &solana_err.kind {
            match data {
                RpcResponseErrorData::Empty => {
                    println!("empty")
                }
                RpcResponseErrorData::SendTransactionPreflightFailure(data) => {
                    println!("{:#?}", data)
                }
                _ => {
                    println!("Unknown error");
                }
            }
        }
    }
}
