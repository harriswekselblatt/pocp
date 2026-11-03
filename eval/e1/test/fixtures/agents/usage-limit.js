// Fails the way a CLI does when the account's usage limit is reached.
process.stderr.write("You've hit your weekly limit · resets 11am\n");
process.exit(1);
