const async = require('async')
const inherits = require('util').inherits
const VM = require('ethereumjs-vm')
const Block = require('ethereumjs-block')
const Account = require('ethereumjs-account')
const Transaction = require('ethereumjs-tx')
const FakeMerklePatriciaTree = require('fake-merkle-patricia-tree')
const ethUtil = require('ethereumjs-util')
const createPayload = require('../util/create-payload.js')
const Subprovider = require('./subprovider.js')

module.exports = VmSubprovider

// handles the following RPC methods:
//   eth_call
//   eth_estimateGas


inherits(VmSubprovider, Subprovider)

function VmSubprovider(opts){
  const self = this
  self.opts = opts || {};
  self.methods = ['eth_call', 'eth_estimateGas']
}

VmSubprovider.prototype.handleRequest = function(payload, next, end) {
  if (this.methods.indexOf(payload.method) < 0) {
    return next()
  }

  const self = this
  // console.log('VmSubprovider - runVm init', arguments)
  self.runVm(payload, function(err, results){
    // console.log('VmSubprovider - runVm return', arguments)
    if (err) return end(err)

    switch (payload.method) {

      case 'eth_call':
        var result = '0x'
        if (!results.error && results.vm.return) {
          // console.log(results.vm.return.toString('hex'))
          result = ethUtil.addHexPrefix(results.vm.return.toString('hex'))
        }
        return end(null, result)

      case 'eth_estimateGas':
        // since eth_estimateGas is just eth_call with
        // a different part of the results,
        // I considered transforming request to eth_call
        // to reduce the cache area, but we'd need to store
        // the full vm result somewhere, instead of just
        // the return value. so instead we just run it again.

        var result = ethUtil.addHexPrefix(results.gasUsed.toString('hex'))
        return end(null, result)

    }
  })
}

VmSubprovider.prototype.runVm = function(payload, cb){
  const self = this

  var blockData = self.currentBlock
  var block = blockFromBlockData(blockData)
  var blockNumber = ethUtil.addHexPrefix(blockData.number.toString('hex'))

  // create vm with state lookup intercepted
  var vm = self.vm = new VM()

  if (self.opts.debug) {
    vm.on('step', function (data) {
      console.log(data.opcode.name)
    })
  }

  vm.stateManager._lookupStorageTrie = self._createAccountStorageTrie.bind(self, blockNumber)
  vm.stateManager.cache._lookupAccount = self._fetchAccount.bind(self, blockNumber)
  var codeStore = new FallbackAsyncStore(function(address, cb){ self._fetchAccountCode(address, blockNumber, cb) })
  vm.stateManager.getContractCode = codeStore.get.bind(codeStore)
  vm.stateManager.setContractCode = codeStore.set.bind(codeStore)
  // create tx
  var txParams = payload.params[0]
  // console.log('params:', payload.params)
  var tx = {
    from: ethUtil.toBuffer(txParams.from),
    value: ethUtil.toBuffer(txParams.value || "0x0"),
    data: ethUtil.toBuffer(txParams.data),
    gasLimit: ethUtil.toBuffer(txParams.gas || block.header.gasLimit),
    gasPrice: ethUtil.toBuffer(txParams.gasPrice),
  };

  if (txParams.to) {
    tx.to = ethUtil.toBuffer(txParams.to);
  }

  // Get the code ourselves because runCall gets the to address from cache,
  // which isn't returning useful data because nothing is in the cache.
  vm.stateManager.getContractCode(tx.to, function(err, code, comp) {
    if (err) return cb(err);

    var params = {
      block: block,
      caller: tx.from,
      code: code,
      data: tx.data,
      gasLimit: tx.gasLimit,
      gasPrice: tx.gasPrice,
      origin: tx.from,
      to: tx.to,
      value: tx.value
    };

    vm.runCall(params, function(err, results) {
      if (results && results.error != null) {
        return cb(new Error("VM error: " + results.error));
      }

      if (results && results.vm && results.vm.exception != 1) {
        return cb(new Error("VM Exception while executing " + payload.method + ": " + results.vm.exceptionError));
      }

      // Use ethereumjs-tx to calculate the basefee of this transaction.
      var transaction = new Transaction(tx);
      var basefee = transaction.getBaseFee();

      // Calculate the total gas used
      // WARNING! This and the next block of code are directly copied from
      // runTx() within ethereumjs-vm. It was the only way to get the right
      // fee while still using runCall directly.
      results.gasUsed = results.gasUsed.add(basefee);

      // refund the accoun.stateManagert
      var gasRefund = results.vm.gasRefund
      if (gasRefund) {
        if (gasRefund.cmp(results.gasUsed.divn(2)) === -1) {
          results.gasUsed.isub(gasRefund)
        } else {
          results.gasUsed.isub(results.gasUsed.divn(2))
        }
      }

      cb(err, results)
    });
  })
}

VmSubprovider.prototype._createAccountStorageTrie = function(blockNumber, address, cb){
  const self = this
  var addressHex = ethUtil.addHexPrefix(address.toString('hex'))
  var storageTrie = new FallbackStorageTrie({
    fetchStorage: fetchStorage,
  })
  cb(null, storageTrie)

  function fetchStorage(key, cb){
    self._fetchAccountStorage(addressHex, key, blockNumber, cb)
  }
}

VmSubprovider.prototype._fetchAccount = function(blockNumber, address, cb){
  const self = this
  var addressHex = ethUtil.addHexPrefix(address.toString('hex'))
  async.parallel({
    nonce: self._fetchAccountNonce.bind(self, addressHex, blockNumber),
    balance: self._fetchAccountBalance.bind(self, addressHex, blockNumber),
  }, function(err, results){
    if (err) return cb(err)

    results._exists = results.nonce !== '0x0' || results.balance != '0x0' || results._code != '0x'
    // console.log('fetch account results:', results)
    var account = new Account(results)
    // needs to be anything but the default (ethUtil.SHA3_NULL)
    account.codeHash = new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
    cb(null, account)
  })

}

VmSubprovider.prototype._fetchAccountStorage = function(address, key, blockNumber, cb){
  const self = this
  self.emitPayload({ method: 'eth_getStorageAt', params: [address, key, blockNumber] }, function(err, results){
    if (err) return cb(err)
    if (results.error) return cb(results.error.message)

    cb(null, results.result)
  })
}

VmSubprovider.prototype._fetchAccountBalance = function(address, blockNumber, cb){
  const self = this
  self.emitPayload({ method: 'eth_getBalance', params: [address, blockNumber] }, function(err, results){
    if (err) return cb(err)
    if (results.error) return cb(results.error.message)
    cb(null, results.result)
  })
}

VmSubprovider.prototype._fetchAccountNonce = function(address, blockNumber, cb){
  const self = this
  self.emitPayload({ method: 'eth_getTransactionCount', params: [address, blockNumber] }, function(err, results){
    if (err) return cb(err)
    if (results.error) return cb(results.error.message);
    cb(null, results.result)
  })
}

VmSubprovider.prototype._fetchAccountCode = function(address, blockNumber, cb){
  const self = this
  self.emitPayload({ method: 'eth_getCode', params: [address, blockNumber] }, function(err, results){
    if (err) return cb(err)
    if (results.error) return cb(results.error.message);
    cb(null, results.result)
  })
}


//
// FallbackStorageTrie
//
// is a FakeMerklePatriciaTree that will let lookups
// fallback to the network. writes shadow the network.
// doesn't bother with a stateRoot
//

inherits(FallbackStorageTrie, FakeMerklePatriciaTree)

function FallbackStorageTrie(opts) {
  const self = this
  FakeMerklePatriciaTree.call(self)
  self._fetchStorage = opts.fetchStorage
}

FallbackStorageTrie.prototype.get = function(key, cb){
  const self = this
  var _super = FakeMerklePatriciaTree.prototype.get.bind(self)

  _super(key, function(err, value){
    if (err) return cb(err)
    if (value) return cb(null, value)
    // if value not in tree, try network
    var keyHex = key.toString('hex')
    self._fetchStorage(keyHex, function(err, rawValue){
      if (err) return cb(err)
      var value = ethUtil.toBuffer(rawValue)
      var encodedValue = ethUtil.rlp.encode(value)
      cb(null, encodedValue)
    })
  })
}

//
// FallbackAsyncStore
//
// is an async key-value store that will let lookups
// fallback to the network. puts are not sent.
//

function FallbackAsyncStore(fetchFn){
  // console.log('FallbackAsyncStore - new')
  const self = this
  self.fetch = fetchFn
  self.cache = {}
}

FallbackAsyncStore.prototype.get = function(address, cb){
  // console.log('FallbackAsyncStore - get', arguments)
  const self = this
  var addressHex = '0x'+address.toString('hex')
  var code = self.cache[addressHex]
  if (code !== undefined) {
    cb(null, code)
  } else {
    // console.log('FallbackAsyncStore - fetch init')
    self.fetch(addressHex, function(err, value){
      // console.log('FallbackAsyncStore - fetch return', arguments)
      if (err) return cb(err)
      value = ethUtil.toBuffer(value);
      self.cache[addressHex] = value
      cb(null, value)
    })
  }
}

FallbackAsyncStore.prototype.set = function(address, code, cb){
  // console.log('FallbackAsyncStore - set', arguments)
  const self = this
  var addressHex = '0x'+address.toString('hex')
  self.cache[addressHex] = code
  cb()
}

// util
const NOT_ENOUGH_FUNDS = 'sender doesn\'t have enough funds to send tx.'
const WRONG_NONCE = 'the tx doesn\'t have the correct nonce. account has nonce of:'
const VM_INTERNAL_ERRORS = [NOT_ENOUGH_FUNDS, WRONG_NONCE]
function isNormalVmError(message){
  var matchedErrors = VM_INTERNAL_ERRORS.filter(function(errorPattern){
    var submessage = message.slice(0,errorPattern.length)
    return submessage === errorPattern
  })
  return matchedErrors.length === 1
}

function blockFromBlockData(blockData){
  var block = new Block()
  // block.header.hash = ethUtil.addHexPrefix(blockData.hash.toString('hex'))

  block.header.parentHash = blockData.parentHash
  block.header.uncleHash = blockData.sha3Uncles
  block.header.coinbase = blockData.miner
  block.header.stateRoot = blockData.stateRoot
  block.header.transactionTrie = blockData.transactionsRoot
  block.header.receiptTrie = blockData.receiptRoot
  block.header.bloom = blockData.logsBloom
  block.header.difficulty = blockData.difficulty
  block.header.number = blockData.number
  block.header.gasLimit = blockData.gasLimit
  block.header.gasUsed = blockData.gasUsed
  block.header.timestamp = blockData.timestamp
  block.header.extraData = blockData.extraData
  return block
}
