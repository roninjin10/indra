#!/bin/bash

ganache_rpc_port=8545
migration_flag_port=8544

mkdir -p /data build/contracts
ganache=./node_modules/.bin/ganache-cli
truffle=./node_modules/.bin/truffle

# Set default env vars
netid=$ETH_NETWORK_ID
[[ -n "$netid" ]] || netid=4447
mnemonic=$ETH_MNEMONIC
[[ -n "$mnemonic" ]] || mnemonic="candy maple cake sugar pudding cream honey rich smooth crumble sweet treat"

echo "Starting Ganache with options: netid=$netid, mnemonic=$mnemonic..."
$ganache --host="0.0.0.0" --port="$ganache_rpc_port" --db="/data" --mnemonic="$mnemonic" --networkId="$netid" --blockTime=3 > ops/ganache.log &
sleep 5

function getHash {
  find build/contracts contracts migrations -type f -not -name "*.swp" \
    | xargs cat | sha256sum | tr -d ' -'
}

function migrate {
  echo && echo "Migration activated! New state: `getHash`" 
  $truffle compile
  $truffle migrate --reset --network docker
  getHash > build/state-hash
}

# Do we need to do an initial migration?
if [[ "`getHash`" != "`cat build/state-hash || true`" ]]
then migrate
else echo "Contracts & migrations are up to date"
fi

function signal_migrations_complete {
  echo "===> Signalling the completion of migrations..."
  while true # unix.stackexchange.com/a/37762
  do sleep 2 && echo 'eth migrations complete' | nc -lk -p $migration_flag_port
  done > /dev/null
}

function watch {
  echo "Watching contract src & artifacts for changes.."
  while true
  do
    if [[ "`getHash`" == "`cat build/state-hash`" ]]
    then sleep 2
    else migrate
    fi
  done
}

if [[ "$1" == "watch" ]]
then
  signal_migrations_complete &
  watch
else
  signal_migrations_complete
fi
