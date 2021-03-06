const EC = artifacts.require("./ECTools.sol");
const CM = artifacts.require("./ChannelManager.sol");
const HumanStandardToken = artifacts.require("./HumanStandardToken.sol");

module.exports = async function(deployer, network, accounts) {

  if (network === "ropsten" || network === "mainnet") {
    return
  }

  let ChannelManager = await CM.deployed();
  let Token = await HumanStandardToken.deployed();

  await Token.approve(ChannelManager.address, web3.utils.toBN(web3.utils.toWei("6969", "ether")))
  await Token.transfer(ChannelManager.address, web3.utils.toBN(web3.utils.toWei("69", "ether")))

  await web3.eth.sendTransaction({
    to: ChannelManager.address,
    value: web3.utils.toBN(web3.utils.toWei("6.9", "ether")),
    from: accounts[0]
  })

  console.log('Migration 4 complete')
};
