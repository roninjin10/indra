import Web3 from 'web3';
import { Transaction } from 'web3/eth/types';

export default async function getTx(web3: Web3, transactionHash: string): Promise<Transaction> {
  return new Promise<any>((resolve, reject) =>
    web3.eth.getTransaction(transactionHash, (err: Error|null, transaction: Transaction) => {
      if (err) {
        reject(err)
      }
      resolve(transaction)
    })  
  )
}
