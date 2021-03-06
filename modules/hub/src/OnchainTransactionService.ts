import { UnconfirmedTransaction } from "./domain/OnchainTransaction";
import { assertUnreachable } from "./util/assertUnreachable";
import { OnchainTransactionsDao, TxnStateUpdate } from "./dao/OnchainTransactionsDao";
import { TransactionRequest, OnchainTransactionRow } from "./domain/OnchainTransaction";
import log from './util/log'
import { default as DBEngine, SQL } from "./DBEngine";
import { default as GasEstimateDao } from "./dao/GasEstimateDao";
import { sleep, synchronized, maybe, Lock, Omit } from "./util";
import { Container } from "./Container";
const Tx = require('ethereumjs-tx')
const Web3 = require('web3')

const LOG = log('OnchainTransactionService')

/**
 * Converts an UnconfirmedTransaction to an instance of Tx from ethereumjs-tx
 */
function txnToTx(txn: Omit<UnconfirmedTransaction, 'hash'>): any {
  return new Tx({
    from: txn.from,
    to: txn.to,
    value: Web3.utils.numberToHex(txn.value),
    gas: Web3.utils.numberToHex(txn.gas),
    gasPrice: Web3.utils.numberToHex(txn.gasPrice),
    data: txn.data,
    nonce: Web3.utils.numberToHex(txn.nonce),
    r: txn.signature && txn.signature.r,
    s: txn.signature && txn.signature.s,
    v: txn.signature && Web3.utils.numberToHex(txn.signature.v),
  })
}

/**
 * Serializes a transaction to a raw string.
 */
function serializeTxn(txn: Omit<UnconfirmedTransaction, 'hash'>): string {
  const tx = txnToTx(txn)
  return '0x' + tx.serialize().toString('hex')
}

/**
 * Serializes a transaction to a raw string.
 */
function generateHash(txn: Omit<UnconfirmedTransaction, 'hash'>, includeSig: boolean = true): string {
  const tx = txnToTx(txn)
  return '0x' + tx.hash(includeSig).toString('hex')
}


/**
 * Service for submitting and monitoring the state of onchain transactions.
 *
 * To use this from other services:
 *
 * 1. Use `sendTransaction(...)` to send a transaction. Note: this should be
 *    called from within a database transaction so as ensure onchain
 *    transactions are batched together with their corresponding offchain
 *    data:
 *
 *      const withdrawal = await withdrawalsDao.createWithdrawal(...)
 *      const txn = await onchainTransactionService.sendTransaction(cxn, {
 *        from: ...,
 *        to: withdrawal.recipient,
 *        value: withdrawal.amount,
 *      })
 *      await withdrawalsDao.setOnchainTransaction(withdrawal, txn.logicalId)
 *
 *    Note: other data models should reference the transaction's `logicalId`.
 *
 * 2. Use `awaitTransaction(...)` to wait for the transaction to succeed or
 *    fail:
 *
 *      const res = await onchainTransactionService.awaitTransaction(withdrawal.onchainTransactionId)
 *      if (res.status == 'confirmed') {
 *        ... handle confirmation ...
 *      } else {
 *        ... handle failure ...
 *      }
 *
 * 3. Additionally, a `completeCallback` can be provided as part of the metadata:
 *
 *      await onchainTransactionService.sendTransaction(..., {
 *        meta: {
 *          completeCallback: 'MyService.someCallback',
 *          ...,
 *        },
 *        ...,
 *      })
 *
 *   If the `completeCallback` is provided, it will be called when the
 *   transaction completes (ie, succeeds or fails), and passed an
 *   OnchainTransactionRow:
 *
 *      class MyService {
 *        async completionCallback(txn: OnchainTransactionRow) {
 *          console.log('Transaction completed:', txn)
 *        }
 *      }
 *
 *   NOTE: the callback method will block processing any other pending
 *   transactions, so be careful not to block for too long.
 *
 */
export class OnchainTransactionService {
  web3: any
  gasEstimateDao: GasEstimateDao
  onchainTransactionDao: OnchainTransactionsDao
  db: DBEngine
  container: Container

  pollFinished = Lock.released()
  stopped: Lock = Lock.released()
  running: boolean = false

  constructor(web3: any, gasEstimateDao: GasEstimateDao, onchainTransactionDao: OnchainTransactionsDao, db: DBEngine, container: Container) {
    this.web3 = web3
    this.gasEstimateDao = gasEstimateDao
    this.onchainTransactionDao = onchainTransactionDao
    this.db = db
    this.container = container
  }

  lookupCallback(name: string): (tx: OnchainTransactionRow) => Promise<void> {
    const [serviceName, methodName] = name.split('.')
    if (!serviceName || !methodName)
      throw new Error(`Invalid callback: ${name}`)

    const service = this.container.resolve(serviceName)
    const method = service[methodName]
    if (!method)
      throw new Error(`Invalid callback: method '${methodName}' does not exist on '${serviceName}'`)

    return method.bind(service)
  }

  /**
   * Sends a transaction to chain.
   *
   * Note: the ``db`` passed in must be from the context of the caller to
   * ensure that the pending transaction is inserted to the database as
   * part of the caller's transaction.
   */
  async sendTransaction(db: DBEngine, txnRequest: TransactionRequest) {
    let { meta, logicalId, ...web3TxRequest } = txnRequest
    meta = meta || {}
    logicalId = logicalId || null

    if (meta.completeCallback) {
      // Verify that the callback exists before doing anything else
      this.lookupCallback(meta.completeCallback)
    }

    const nonce = Math.max(
      await this.web3.eth.getTransactionCount(txnRequest.from),
      (await db.queryOne(SQL`
        select coalesce(max(nonce), 0) + 1 as nonce
        from onchain_transactions_raw
        where
          "from" = ${txnRequest.from} and
          state <> 'failed'
      `)).nonce,
    )

    const gasPrice = await this.gasEstimateDao.latest()
    if (!gasPrice)
      throw new Error('gasEstimateDao.latest() returned null')

    const gasAmount = this.web3.utils.hexToNumber(await this.web3.eth.estimateGas({ ...web3TxRequest }))

    const unsignedTx = {
      from: txnRequest.from,
      to: txnRequest.to,
      value: txnRequest.value || '0',
      gasPrice: this.web3.utils.toWei('' + gasPrice.fast, 'gwei'),
      gas: gasAmount,
      data: txnRequest.data || '0x',
      nonce: nonce,
    }

    /* TODO: REB-61
    const sig = await this.web3.eth.signTransaction({ ...unsignedTx })
    const tx = {
      ...unsignedTx,
      hash: sig.tx.hash,
      signature: {
        r: sig.tx.r,
        s: sig.tx.s,
        v: this.web3.utils.hexToNumber(sig.tx.v),
      }
    }
    */

    const tx = {
      ...unsignedTx,
      hash: null,
      signature: null,
    }

    // Note: this is called from within the transactional context of the caller
    const txnRow = await this.onchainTransactionDao.insertTransaction(db, logicalId, meta, tx)
    await db.onTransactionCommit(() => this.poll())

    return txnRow
  }

  @synchronized('stopped')
  async start(pollInterval?: number) {
    this.running = true
    while (this.running) {
      try {
        await this.poll()
        if (this.running)
          await sleep(pollInterval = 1000)
      } catch (e) {
        LOG.error(`Error polling pending transactions (will retry in 30s): ${'' + e}\n${e.stack}`)
        if (this.running)
          await sleep(30 * 1000)
      }
    }
  }

  async stop() {
    if (!this.running)
      return
    LOG.info('Stopping transaction poller...')
    this.running = false
    await this.stopped
    LOG.info('Transaction poller stopped.')
  }

  @synchronized('pollFinished')
  async poll() {
    for (const txn of await this.onchainTransactionDao.getPending(this.db))
      await this.processPendingTxn(txn)
  }

  private async processPendingTxn(txn: OnchainTransactionRow): Promise<void> {
    if (txn.state == 'new') {
      const error = await new Promise(res => {
        // const tx = this.web3.eth.sendSignedTransaction(serializeTxn(txn)) TODO: REB-61
        const tx = this.web3.eth.sendTransaction(txn)
        tx.on('transactionHash', hash => {
          // TODO: REB-61
          this.db.query(SQL`
            UPDATE onchain_transactions_raw
            SET hash = ${hash}
            WHERE id = ${txn.id}
          `)
          res(null)
        })
        tx.on('error', err => res(err))
      })

      LOG.info('Sending transaction {txn.hash}: {res}', {
        txn,
        res: error ? '' + error : 'ok!',
      })

      if (!error || this.errorIsTxnAlreadyImported(error)) {
        await this.updateTxState(txn, {
          state: 'submitted',
        })
        return
      }

      if (this.web3ErrorIsTemporary(error)) {
        // If the error is temporary (ex, network error), do nothing; this txn
        // will be retried on the next loop.
        LOG.warning(`Temporary error while submitting tx '${txn.hash}': ${'' + error} (will retry)`)
        return
      }

      // In the future we'll be able to be more intelligent about retrying (ex,
      // with a new nonce or more gas) here... but for now, just fail.
      await this.updateTxState(txn, {
        state: 'failed',
        reason: '' + error,
      })
      return
    }

    if (txn.state == 'submitted') {
      const [tx, err] = await maybe(this.web3.eth.getTransaction(txn.hash)) as any
      LOG.info('State of {txn.hash}: {res}', {
        txn,
        res: JSON.stringify(tx || err),
      })
      if (err) {
        // TODO: what errors can happen here?
        LOG.warning(`Error checking status of tx '${txn.hash}': ${'' + err} (will retry)`)
        return
      }

      if (!tx || !tx.blockNumber) {
        const txnAgeS = (Date.now() - (+new Date(txn.submittedOn))) / 1000
        const txnAge = `${Math.floor(txnAgeS / 60)}m ${Math.floor(txnAgeS % 60)}s`

        // Strictly speaking, this is not 100% safe. In reality we should
        // also be checking to see if there's another confirmed transaction
        // with an equal or higher nonce too... but this is probably safe for
        // now.
        if (txnAgeS > 60 * 15) {
          LOG.warning(`Transaction '${txn.hash}' has been unconfirmed for ${txnAge}; marking failed.`)
          await this.updateTxState(txn, {
            state: 'failed',
            reason: `timeout (${txnAge})`,
          })
          return
        }

        LOG.info(`Pending transaction '${txn.hash}' not yet confirmed (age: ${txnAge})`)
        return
      }

      await this.updateTxState(txn, {
        state: 'confirmed',
        blockNum: tx.blockNumber,
        blockHash: tx.blockHash,
        transactionIndex: tx.transactionIndex,
      })

      return
    }

    // This really shouldn't happened, but it's safe to ignore if it does.
    if (txn.state == 'confirmed' || txn.state == 'failed')
      return

    assertUnreachable(txn.state, 'unexpected txn.state:')

  }

  private async updateTxState(txn: OnchainTransactionRow, state: TxnStateUpdate) {
    txn = await this.onchainTransactionDao.updateTransactionState(this.db, txn.id, state)
    if ((txn.state == 'confirmed' || txn.state == 'failed') && txn.meta.completeCallback) {
      const callback = this.lookupCallback(txn.meta.completeCallback)
      await new Promise(async res => {
        const timeout = setTimeout(() => {
          LOG.error('Txn complete callback {callbackName} taking too long to process txn {txn}!', {
            callbackName: txn.meta.completeCallback,
            txn,
          })
          res()
        }, 30 * 1000)
        try {
          await callback(txn)
        } finally {
          clearTimeout(timeout)
          res()
        }
      })
    }
  }

  /**
   * Waits for the transaction to complete (ie, it's confirmed or failed), then
   * return it.
   */
  async awaitTransaction(logicalId: Number): Promise<OnchainTransactionRow> {
    while (true) {
      const txn = await this.onchainTransactionDao.getTransactionByLogicalId(this.db, logicalId)
      if (txn.state == 'failed' || txn.state == 'confirmed')
        return txn
      await this.pollFinished
    }
  }

  web3ErrorIsTemporary(err: any) {
    return ('' + err).indexOf('Invalid JSON RPC response: ""') >= 0
  }

  errorIsTxnAlreadyImported(err: any) {
    return ('' + err).indexOf('same hash was already imported') >= 0
  }
}
