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

Get current state:
```bash
anchor run status --provider.cluster devnet
```

Add rewards:
```bash
anchor run add-rewards --provider.cluster devnet -- --amount 10_000
```

Change withdrawal delay:
```bash
anchor run configure-withdrawal-delay --provider.cluster devnet -- --days 5
```