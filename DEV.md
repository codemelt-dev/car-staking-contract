# SPL Staking Locked Program

Description in the [DOCS.md](./DOCS.md) file and in [design](./design/) directory.

## Commands

### Testing
Running Tests:
```bash
anchor test tests/spl-staking-locked.ts
```

### Deploying
#### Devnet
```bash
anchor deploy --provider.cluster devnet
```


Created SPL token for testing: `2TB758LUSDovyzFEZuHhj9dBCbk79qvhia2bHRyhKErN`



Intialize:
```bash
anchor run initialize --provider.cluster devnet -- --token 2TB758LUSDovyzFEZuHhj9dBCbk79qvhia2bHRyhKErN
```

#### Mainnet

```bash
solana config set --url mainnet-beta
```

Build verifiable build:
```bash
anchor build --verifiable
```
Deploy:
```bash
anchor deploy --provider.cluster mainnet -- --with-compute-unit-price 100
```
3JJfEkgwY1avbhtfqFvWxphrBsgMLXjToUN4SFZHqk8NHKUV2aFc69NZEW2L1xsoFiNCvRdb251Qsry95Dbhoqdx

Upgrade:
```bash
anchor upgrade -p E4ix78FMZ2HPjKvAyvRXJ4v5ipqZYkVUuswjuHkX7Q3v --provider.cluster mainnet ./target/verifiable/spl_staking_locked.so --max-retries 5 -- --with-compute-unit-price 100
```

Intialize:
```bash
anchor run initialize --provider.cluster mainnet -- --token 7oBYdEhV4GkXC19ZfgAvXpJWp2Rn9pm1Bx2cVNxFpump
```

Upload IDL:
```bash
anchor idl init --provider.cluster mainnet --filepath target/idl/spl_staking_locked.json E4ix78FMZ2HPjKvAyvRXJ4v5ipqZYkVUuswjuHkX7Q3v
```

Verify:
```bash
solana-verify verify-from-repo -b solanafoundation/anchor:v0.31.1 https://github.com/codemelt-dev/car-staking-contract --program-id E4ix78FMZ2HPjKvAyvRXJ4v5ipqZYkVUuswjuHkX7Q3v
```

Submit for remote verification:
```bash
solana-verify verify-from-repo -b solanafoundation/anchor:v0.31.1 https://github.com/codemelt-dev/car-staking-contract --remote --program-id E4ix78FMZ2HPjKvAyvRXJ4v5ipqZYkVUuswjuHkX7Q3v             
```

### Housekeeping
Get current state:
```bash
anchor run status --provider.cluster devnet
```

Add rewards:
```bash
anchor run add-rewards --provider.cluster devnet -- --amount 10_000
```
```bash
anchor run add-rewards --provider.cluster mainnet -- --amount 10_000
```
5hxV7H6mUfbVoE5r2qCGWLVjas4XUKzBf8Ug5mR7Lgzq59hznH5xgsEjqHkqcKorNpdL9LzDJq3RNaEkC52ZKxFx

Change withdrawal delay:
```bash
anchor run configure-withdrawal-delay --provider.cluster devnet -- --days 5
```
