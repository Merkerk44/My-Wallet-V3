var MyWallet = module.exports = {};

var assert = require('assert');
var Bitcoin = require('bitcoinjs-lib');
var ECKey = Bitcoin.ECKey;
var BigInteger = require('bigi');
var Buffer = require('buffer');
var Base58 = require('bs58');
var BIP39 = require('bip39');

var WalletStore = require('./wallet-store');
var WalletCrypto = require('./wallet-crypto');
var WalletSignup = require('./wallet-signup');
var ImportExport = require('./import-export');
var HDWallet = require('./hd-wallet');
var HDAccount = require('./hd-account');
var Transaction = require('./transaction');
var BlockchainAPI = require('./blockchain-api');


//------
//Should find somewhere else for these

function parseValueBitcoin(valueString) {
  var valueString = valueString.toString();
  // TODO: Detect other number formats (e.g. comma as decimal separator)
  var valueComp = valueString.split('.');
  var integralPart = valueComp[0];
  var fractionalPart = valueComp[1] || "0";
  while (fractionalPart.length < 8) fractionalPart += "0";
  fractionalPart = fractionalPart.replace(/^0+/g, '');
  var value = BigInteger.valueOf(parseInt(integralPart));
  value = value.multiply(BigInteger.valueOf(100000000));
  value = value.add(BigInteger.valueOf(parseInt(fractionalPart)));
  return value;
}

//user precision (e.g. BTC or mBTC) to satoshi big int
function precisionToSatoshiBN(x) {
  return parseValueBitcoin(x).divide(BigInteger.valueOf(Math.pow(10, sShift(symbol_btc)).toString()));
}

//-----


var isInitialized = false;

MyWallet.securePost = function(url, data, success, error) {
  var clone = jQuery.extend({}, data);
  var sharedKey = WalletStore.getSharedKey();

  if (!data.sharedKey) {
    if (!sharedKey || sharedKey.length == 0 || sharedKey.length != 36) {
      throw 'Shared key is invalid';
    }

    //Rather than sending the shared key plain text
    //send a hash using a totp scheme
    var now = new Date().getTime();
    var timestamp = parseInt((now - WalletStore.getServerTimeOffset()) / 10000);

    var SKHashHex = CryptoJS.SHA256(sharedKey.toLowerCase() + timestamp).toString();

    var i = 0;
    var tSKUID = SKHashHex.substring(i, i+=8)+'-'+SKHashHex.substring(i, i+=4)+'-'+SKHashHex.substring(i, i+=4)+'-'+SKHashHex.substring(i, i+=4)+'-'+SKHashHex.substring(i, i+=12);

    clone.sharedKey = tSKUID;
    clone.sKTimestamp = timestamp;

    // Needed for debugging and as a fallback if totp scheme doesn't work on server
    clone.sKDebugHexHash = SKHashHex;
    clone.sKDebugTimeOffset = WalletStore.getServerTimeOffset();
    clone.sKDebugOriginalClientTime = now;
    clone.sKDebugOriginalSharedKey = sharedKey;
  }

  if (!data.guid)
    clone.guid = WalletStore.getGuid();

  clone.format =  data.format ? data.format : 'plain';
  clone.api_code = WalletStore.getAPICode();

  var dataType = 'text';
  if (data.format == 'json')
    dataType = 'json';

  $.ajax({
    dataType: dataType,
    type: "POST",
    timeout: 60000,
    xhrFields: {
      withCredentials: true
    },
    url: BlockchainAPI.getRootURL() + url,
    data : clone,
    success: success,
    error : error
  });
};

function hashPassword(password, iterations) {
  //N rounds of SHA 256
  var round_data = CryptoJS.SHA256(password);
  for (var i = 1; i < iterations; ++i) {
    round_data = CryptoJS.SHA256(round_data);
  }
  return round_data.toString();
};

/**
 * Set the number of PBKDF2 iterations used for encrypting the wallet and also the private keys if the second password is enabled.
 * @param {number} pbkdf2_iterations The number of PBKDF2 iterations.
 * @param {function()} success Success callback function.
 * @param {function(?Object)} error Error callback function.
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 */
MyWallet.setPbkdf2Iterations = function(pbkdf2_iterations, success, error, getPassword) {
  var previous_pbkdf2_iterations = WalletStore.setPbkdf2Iterations(pbkdf2_iterations);

  if(pbkdf2_iterations == previous_pbkdf2_iterations) {
    success();
    return;
  }

  var panic = function(e) {
    console.log('Panic ' + e);

    error(e);

    // If we caught an exception here the wallet could be in a inconsistent state
    // We probably haven't synced it, so no harm done
    // But for now panic!
    window.location.reload();
  };

  var setPbkdf2IterationsAndBackupWallet = function() {
    WalletStore.setPbkdf2Iterations(pbkdf2_iterations);
    success();
    MyWallet.backupWalletDelayed('update', function() {
    }, function(e) {
      panic(e);
    });
  };

  try {
    // If double encryption is enabled we need to re-encrypt all private keys
    if(WalletStore.getDoubleEncryption()) {
      getPassword(
        function(pw, correct_password, wrong_password) {
          if (MyWallet.validateSecondPassword(pw)) {
            correct_password();
            WalletStore.mapToLegacyAddressesPrivateKeys(WalletCrypto.reencrypt(pw, WalletStore.getSharedKey(), previous_pbkdf2_iterations, pbkdf2_iterations));

            // Re-encrypt all HD account keys
            for (var i in MyWallet.getAccounts()) {
              var account = WalletStore.getHDWallet().getAccount(i);
              account.extendedPrivateKey = WalletCrypto.reencrypt(pw, WalletStore.getSharedKey(), previous_pbkdf2_iterations, pbkdf2_iterations)(account.extendedPrivateKey);

              if (!account.extendedPrivateKey) throw 'Error re-encrypting account private key';
            }

            // Re-encrypt the HD seed
            if (WalletStore.didUpgradeToHd()) {
              WalletStore.getHDWallet().seedHex = WalletCrypto.reencrypt(pw, WalletStore.getSharedKey(), previous_pbkdf2_iterations, pbkdf2_iterations)(WalletStore.getHDWallet().seedHex);

              if (!WalletStore.getHDWallet().seedHex) throw 'Error re-encrypting wallet seed';
            }
            
            // Re-encrypt the BIP 39 password
            if (WalletStore.didUpgradeToHd()) {
              if(WalletStore.getHDWallet().getBip39Password() != "") {
                WalletStore.getHDWallet().setBip39Password(WalletCrypto.reencrypt(pw, WalletStore.getSharedKey(), previous_pbkdf2_iterations, pbkdf2_iterations)(WalletStore.getHDWallet().getBip39Password()));
              }

              if (!WalletStore.getHDWallet().getBip39Password()) throw 'Error re-encrypting wallet bip 39 password';
            }

            // Generate a new password hash
            WalletStore.setDPasswordHash(hashPassword(WalletStore.getSharedKey() + pw, pbkdf2_iterations));
            setPbkdf2IterationsAndBackupWallet();
          }
          else {
            wrong_password();
          }
        });
    }
    else {
      setPbkdf2IterationsAndBackupWallet();
    }
  } catch (e) {
    panic(e);
  }
};

MyWallet.B58LegacyDecode = function(input) {
  var alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var base = BigInteger.valueOf(58);

  var bi = BigInteger.valueOf(0);
  var leadingZerosNum = 0;
  for (var i = input.length - 1; i >= 0; i--) {
    var alphaIndex = alphabet.indexOf(input[i]);

    bi = bi.add(BigInteger.valueOf(alphaIndex)
                .multiply(base.pow(input.length - 1 -i)));

    // This counts leading zero bytes
    if (input[i] == "1") leadingZerosNum++;
    else leadingZerosNum = 0;
  }
  var bytes = bi.toByteArrayUnsigned();

  // Add leading zeros
  while (leadingZerosNum-- > 0) bytes.unshift(0);

  return bytes;
};

/**
 * @param {function()} success callback function
 * @param {function()} error callback function
 */
MyWallet.unsetSecondPassword = function(success, error, getPassword) {
  var sharedKey = WalletStore.getSharedKey();
  var pbkdf2_iterations = WalletStore.getPbkdf2Iterations();

  var panic = function(e) {
    console.log('Panic ' + e);

    //If we caught an exception here the wallet could be in a inconsistent state
    //We probably haven't synced it, so no harm done
    //But for now panic!
    window.location.reload();
  };
  var decrypt = function(pw) {
    var dec = function(data) {
      return WalletCrypto.decryptSecretWithSecondPassword(data, pw, sharedKey, pbkdf2_iterations);
    };
    return dec;
  };

  try {
    getPassword(function(pw, correct_password, wrong_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();

        WalletStore.mapToLegacyAddressesPrivateKeys(decrypt(pw));

        for (var i in MyWallet.getAccounts()) {
          var account = WalletStore.getHDWallet().getAccount(i);
          account.extendedPrivateKey = WalletCrypto.decryptSecretWithSecondPassword(account.extendedPrivateKey, pw, sharedKey, pbkdf2_iterations);
        }

        if (WalletStore.didUpgradeToHd()) {
          WalletStore.getHDWallet().seedHex = WalletCrypto.decryptSecretWithSecondPassword(WalletStore.getHDWallet().seedHex, pw, sharedKey, pbkdf2_iterations);
          if(WalletStore.getHDWallet().getBip39Password() != "") {
            WalletStore.getHDWallet().setBip39Password(WalletCrypto.decryptSecretWithSecondPassword(WalletStore.getHDWallet().getBip39Password(), pw, sharedKey, pbkdf2_iterations));
          }
        }

        WalletStore.setDoubleEncryption(false);

        MyWallet.checkAllKeys(null);

        MyWallet.backupWallet('update', function() {
          success();
        }, function(e) {
          error(e);
          panic(e);
        });
      } else {
        wrong_password();
      }
    });
  } catch (e) {
    console.log(e);
    panic(e);
    // error(e);
  }
};


/**
 * @param {string} password Second password
 * @param {function()} success callback function
 * @param {function()} error callback function
 */
MyWallet.setSecondPassword = function(password, success, error) {
  var panic = function(e) {
    console.log('Panic ');
    console.log(e);

    //If we caught an exception here the wallet could be in a inconsistent state
    //We probably haven't synced it, so no harm done
    //But for now panic!
    // window.location.reload();
  };

  var sharedKey = WalletStore.getSharedKey();
  var pbkdf2_iterations = WalletStore.getPbkdf2Iterations();

  var encrypt = function(pw) {
    var enc = function(data) {
      return WalletCrypto.encryptSecretWithSecondPassword(data, pw, sharedKey, pbkdf2_iterations);
    };
    return enc;
  };

  try {
    WalletStore.setDoubleEncryption(true);
    WalletStore.mapToLegacyAddressesPrivateKeys(encrypt(password, WalletStore.getSharedKey(), pbkdf2_iterations));

    for (var i in MyWallet.getAccounts()) {
      var account = WalletStore.getHDWallet().getAccount(i);
      account.extendedPrivateKey = WalletCrypto.encryptSecretWithSecondPassword(account.extendedPrivateKey, password, sharedKey, pbkdf2_iterations);
    }

    if (WalletStore.didUpgradeToHd()) {
      WalletStore.getHDWallet().seedHex = WalletCrypto.encryptSecretWithSecondPassword(WalletStore.getHDWallet().seedHex, password, sharedKey, pbkdf2_iterations);
      if(WalletStore.getHDWallet().getBip39Password() != "") {
        WalletStore.getHDWallet().setBip39Password(WalletCrypto.encryptSecretWithSecondPassword(WalletStore.getHDWallet().getBip39Password(), password, sharedKey, pbkdf2_iterations));
      }    
    }

    WalletStore.setDPasswordHash(hashPassword(sharedKey + password, pbkdf2_iterations));
    if (!MyWallet.validateSecondPassword(password)) {
      throw "Invalid Second Password";
    }

    try {
      MyWallet.checkAllKeys(password);

      MyWallet.backupWallet('update', function() {
        success();
      }, function(e) {
        panic(e);
        error(e);
      });
    } catch(e) {
      panic(e);
      error(e);
    }

  } catch(e) {
    panic(e);
    error(e);
  }
};



/**
 * Add watch only address, backup wallet and refreshes balances.
 * @param {string} addressString bitcoin address
 */
MyWallet.addWatchOnlyLegacyAddress = function(addressString) {
  var address = Bitcoin.Address.fromBase58Check(addressString);

  if (address.toString() != addressString) {
    throw 'Inconsistency between addresses';
  }

  try {
    if (WalletStore.addLegacyAddress(addressString)) {
      WalletStore.sendEvent("msg", {type: "success", message: 'Successfully Added Address ' + address});

      try {
        ws.send('{"op":"addr_sub", "addr":"'+addressString+'"}');
      } catch (e) { }

      //Backup
      MyWallet.backupWallet('update', function() {
        MyWallet.get_history();
      });
    } else {
      throw 'Wallet Full Or Addresses Exists';
    }
  } catch (e) {
    WalletStore.sendEvent("msg", {type: "error", message: e});
  }
};

//temperary workaround instead instead of modding bitcoinjs to do it TODO: not efficient
MyWallet.getCompressedAddressString = function(key) {
  return new ECKey(key.d, true).pub.getAddress().toString();
};
MyWallet.getUnCompressedAddressString = function(key) {
  return new ECKey(key.d, false).pub.getAddress().toString();
};

MyWallet.extractAddresses = function(script, addresses) {
  switch (Bitcoin.scripts.classifyOutput(script)) {
  case 'pubkeyhash':
    addresses.push(Bitcoin.Address.fromOutputScript(script));
    return 1;
  case 'pubkey':
    addresses.push(new Bitcoin.Address(Bitcoin.crypto.hash160(script.chunks[0]), Bitcoin.networks.bitcoin.pubKeyHash));
    return 1;
  case 'scripthash':
    //if script output is to a multisig address, classifyOutput will return scripthash
    addresses.push(Bitcoin.Address.fromOutputScript(script));
    return 1;
  case 'multisig':
    for (var i = 1; i < script.chunks.length-2; ++i) {
      addresses.push(new Bitcoin.Address(Bitcoin.crypto.hash160(script.chunks[i]), Bitcoin.networks.bitcoin.pubKeyHash));
    }
    return script.chunks[0] - Bitcoin.opcodes.OP_1 + 1;
  default:
    throw 'Encountered non-standard scriptPubKey';
  }
};

/**
 * Import Private Key, backup wallet and refresh balances
 * @param {string} privateKeyString private Key
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 * @param {function(function(string, function, function))} getBIP38Password Get the BIP38 password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getBIP38Password function if the right or wrong password was entered.
 * @param {function()} success callback function
 * @param {function()} alreadyImportedCallback callback function in case the key already exists in the wallet
 * @param {function()} error callback function
 */
MyWallet.importPrivateKey = function(privateKeyString, getPassword, getBIP38Password, success, alreadyImportedCallback, error) {
  function reallyInsertKey(key, compressed, pw) {
    try {
      if (WalletStore.legacyAddressExists(key.pub.getAddress().toString()) &&
          !WalletStore.isWatchOnlyLegacyAddress(key.pub.getAddress().toString())) {
        alreadyImportedCallback();
        return;
      }

      var address = MyWallet.addPrivateKey(key, {compressed : compressed, app_name : APP_NAME, app_version : APP_VERSION}, pw);

      if (!address) {
        throw 'Unable to add private key for bitcoin address ' + address;
      }

      MyWallet.backupWallet('update', function() {
        MyWallet.get_history();
      });

      success(address);
    } catch (e) {
      error(e);
    }
  }

  var format;
  try {
    format = MyWallet.detectPrivateKeyFormat(privateKeyString);
  }
  catch (e) {
    error(e);
    return;
  }

  if (format == 'bip38') {
    getBIP38Password(function(_password, correct_password, wrong_password) {
      WalletStore.disableLogout();
      ImportExport.parseBIP38toECKey(
        privateKeyString,
        _password,
        function(key, isCompPoint) {
          WalletStore.enableLogout();
          correct_password();
          if(WalletStore.getDoubleEncryption()) {
            getPassword(function(pw, correct_password, wrong_password) {
              if (MyWallet.validateSecondPassword(pw)) {
                correct_password();
                reallyInsertKey(key, isCompPoint, pw);
              } else {
                wrong_password();
                error('Second Password incorrect');
              }
            });
          } else {
            reallyInsertKey(key, isCompPoint, null);
          }
        },
        function() {
          WalletStore.disableLogout();
          wrong_password();
        },
        function(e) {
          WalletStore.enableLogout();
          error(e);
        }
      );
    });

    return;
  }

  var key;
  try {
    key = MyWallet.privateKeyStringToKey(privateKeyString, format);
  }
  catch (e) {
    error(e);
    return;
  }

  if(WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, wrong_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        reallyInsertKey(key, (format == 'compsipa'), pw);
      } else {
        wrong_password();
        error('Second Password incorrect');
      }
    });
  } else {
    reallyInsertKey(key, (format == 'compsipa'), null);
  }
};

//opts = {compressed, app_name, app_version, created_time}
// TODO: this can be moved to walletstore
MyWallet.addPrivateKey = function(key, opts, second_password) {
  var sharedKey = WalletStore.getSharedKey();
  var pbkdf2_iterations = WalletStore.getPbkdf2Iterations();

  if (WalletStore.walletIsFull()) {
    throw 'Wallet is full.';
  }

  if (key == null) {
    throw 'Cannot add null key.';
  }

  if (opts == null)
    opts = {compressed: true};

  var addr = opts.compressed ? MyWallet.getCompressedAddressString(key) : MyWallet.getUnCompressedAddressString(key);

  var base58 = Base58.encode(key.d.toBuffer(32));

  var encoded = base58 == null || second_password == null ? base58 : WalletCrypto.encryptSecretWithSecondPassword(base58, second_password, sharedKey, pbkdf2_iterations);

  if (encoded == null) {
    throw 'Error Encoding key';
  }

  var decoded_base_58 = second_password == null ? base58 : WalletCrypto.decryptSecretWithSecondPassword(encoded, second_password, sharedKey, pbkdf2_iterations);

  var decoded_key = new ECKey(new BigInteger.fromBuffer(decoded_base_58), opts.compressed);

  if (addr != MyWallet.getUnCompressedAddressString(key) && addr != MyWallet.getCompressedAddressString(key)) {
    throw 'Decoded Key address does not match generated address';
  }

  if (addr != MyWallet.getUnCompressedAddressString(key) && addr != MyWallet.getCompressedAddressString(key)) {
    throw 'Decoded Key address does not match generated address';
  }

  //TODO: Move this once opts and probably all addPrivateKey func to walletstore
  var addresses = WalletStore.getAddresses();
  if (WalletStore.addLegacyAddress(addr, encoded)) {
    addresses[addr].tag = 1; //Mark as unsynced
    addresses[addr].created_time = opts.created_time ? opts.created_time : 0; //Stamp With Creation time
    addresses[addr].created_device_name = opts.app_name ? opts.app_name : APP_NAME; //Created Device
    addresses[addr].created_device_version = opts.app_version ? opts.app_version : APP_VERSION; //Created App Version

    if (addresses[addr].priv != encoded)
      throw 'Address priv does not match encoded';

    //Subscribe to transaction updates through websockets
    try {
      ws.send('{"op":"addr_sub", "addr":"'+addr+'"}');
    } catch (e) { }
  } else {
    throw 'Unable to add generated private key.';
  }

  return addr;
};

MyWallet.generateNewKey = function(_password) {
  var key = Bitcoin.ECKey.makeRandom(true);

  // key is uncompressed, so cannot passed in opts.compressed = true here
  if (MyWallet.addPrivateKey(key)) {
    return key;
  }
};

MyWallet.generateNewMiniPrivateKey = function() {
  // Documentation: https://en.bitcoin.it/wiki/Mini_private_key_format
  while (true) {
    //Use a normal ECKey to generate random bytes
    var key = Bitcoin.ECKey.makeRandom(false);

    //Make Candidate Mini Key
    var minikey = 'S' + Base58.encode(key.d.toBuffer(32)).substr(0, 21);

    //Append ? & hash it again
    var bytes_appended = Bitcoin.crypto.sha256(minikey + '?');

    //If zero byte then the key is valid
    if (bytes_appended[0] == 0) {

      //SHA256
      var bytes = Bitcoin.crypto.sha256(minikey);

      var eckey = new Bitcoin.ECKey(new BigInteger.fromBuffer(bytes), false);

      if (MyWallet.addPrivateKey(eckey, {compressed: true}))
        return {key : eckey, miniKey : minikey};
    }
  }
};

function wsSuccess(ws) {
  var last_on_change = null;

  ws.onmessage = function(message) {

    var obj = $.parseJSON(message.data);

    var transactions = WalletStore.getTransactions();

    if (obj.op == 'on_change') {
      var old_checksum = WalletStore.generatePayloadChecksum();
      var new_checksum = obj.checksum;

      if (last_on_change != new_checksum && old_checksum != new_checksum) {
        last_on_change = new_checksum;

        MyWallet.getWallet();
      }

    } else if (obj.op == 'utx') {
      WalletStore.setIsAccountRecommendedFeesValid(false);

      var tx = TransactionFromJSON(obj.x);

      var tx_processed = MyWallet.processTransaction(tx);
      var tx_account = tx_processed.to.account;

      //Check if this is a duplicate
      //Maybe should have a map_prev to check for possible double spends
      for (var key in transactions) {
        if (transactions[key].txIndex == tx.txIndex) return;
      }

      WalletStore.addToFinalBalance(tx_processed.result);

      var account = MyWallet.getAccount(tx_account.index);

      if (tx_account) account.setBalance(account.getBalance() + tx_processed.result);

      WalletStore.incNTransactions();

      tx.setConfirmations(0);

      WalletStore.pushTransaction(tx);

      playSound('beep');

      WalletStore.sendEvent('on_tx');

    }  else if (obj.op == 'block') {
      //Check any transactions included in this block, if the match one our ours then set the block index
      for (var i = 0; i < obj.x.txIndexes.length; ++i) {
        for (var ii = 0; ii < transactions.length; ++ii) {
          if (transactions[ii].txIndex == obj.x.txIndexes[i]) {
            if (transactions[ii].blockHeight == null || transactions[ii].blockHeight == 0) {
              transactions[ii].blockHeight = obj.x.height;
              break;
            }
          }
        }
      }

      WalletStore.setLatestBlock(BlockFromJSON(obj.x));

      WalletStore.sendEvent('on_block');
    }

  };

  ws.onopen = function() {
    WalletStore.sendEvent('ws_on_open');

    var msg = '{"op":"blocks_sub"}';

    if (WalletStore.getGuid() != null)
      msg += '{"op":"wallet_sub","guid":"'+WalletStore.getGuid()+'"}';

    try {
      var addrs = WalletStore.getLegacyActiveAddresses();
      for (var key in addrs) {
        msg += '{"op":"addr_sub", "addr":"'+ addrs[key] +'"}'; //Subscribe to transactions updates through websockets
      }

      if (WalletStore.getHDWallet() != null)
        MyWallet.listenToHDWalletAccounts();

    } catch (e) {
      WalletStore.sendEvent("msg", {type: "error", message: 'error with websocket'});
    }

    ws.send(msg);
  };

  ws.onclose = function() {
    WalletStore.sendEvent('ws_on_close');

  };
}

MyWallet.pkBytesToSipa = function(bytes, addr) {
  var bytesBigInt = new BigInteger.fromBuffer(bytes);
  var eckey = new ECKey(bytesBigInt, false);

  bytes = bytesBigInt.toByteArray();

  while (bytes.length < 32) bytes.unshift(0);

  bytes.unshift(0x80); // prepend 0x80 byte

  if (MyWallet.getUnCompressedAddressString(eckey) == addr) {
  } else if (MyWallet.getCompressedAddressString(eckey) == addr) {
    bytes.push(0x01);    // append 0x01 byte for compressed format
  } else {
    throw 'Private Key does not match bitcoin address' + addr;
  }

  var checksum = Crypto.SHA256(Crypto.SHA256(bytes, { asBytes: true }), { asBytes: true });

  bytes = bytes.concat(checksum.slice(0, 4));

  var privWif = Base58.encode(new Buffer(bytes));

  return privWif;
};

function noConvert(x) { return x; }
function base58ToBase58(x) { return WalletCrypto.decryptSecretWithSecondPasswordIfNeeded(x); }
function base58ToBase64(x) { var bytes = MyWallet.decodePK(x); return Crypto.util.bytesToBase64(bytes); }
function base58ToHex(x) { var bytes = MyWallet.decodePK(x); return Crypto.util.bytesToHex(bytes); }
MyWallet.base58ToSipa = function(x, addr) {
  return MyWallet.pkBytesToSipa(MyWallet.decodePK(x), addr);
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @return {string} account label
 */
MyWallet.getLabelForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).getLabel();
};

/**
 * Validates proposed label for account
 * @param {string} label account label
 * @return {boolean} success or not
 */
MyWallet.validateAccountLabel = function(label) {
  if (! MyWallet.isAlphaNumericSpace(label))
    return false;

  if (!label || label == "" || label.length > 17)
    return false;

  return true;
};

/**
 * Set label for account and backup wallet.
 * @param {number} accountIdx index of HD wallet account
 * @param {string} label account label
 * @return {boolean} success or not
 */
MyWallet.setLabelForAccount = function(accountIdx, label) {
  if (!this.validateAccountLabel(label))
    return false;

  WalletStore.getHDWallet().getAccount(accountIdx).setLabel(label);
  MyWallet.backupWalletDelayed();
  return true;
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @return {boolean} is account archived
 */
MyWallet.isArchivedForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).isArchived();
};

/**
 * Set account archived flag to isArchived and backup wallet.
 * @param {number} accountIdx index of HD wallet account
 * @param {boolean} isArchived is archived
 */
MyWallet.setIsArchivedForAccount = function(accountIdx, isArchived) {
  WalletStore.getHDWallet().getAccount(accountIdx).setIsArchived(isArchived);
  MyWallet.backupWalletDelayed('update', function() {
    MyWallet.get_history();
  });
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @return {number} balance of account in satoshis
 */
MyWallet.getBalanceForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).getBalance();
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @return {number} number of transactions for account
 */
MyWallet.getNumberOfTransactionsForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).n_tx;
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @return {string} next unused address
 */
MyWallet.getReceivingAddressForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).getReceivingAddress();
};

MyWallet.getReceivingAddressIndexForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).getReceivingAddressIndex();
};

/**
 * @param {number} accountIdx index of HD wallet account
 * @param {number} addressIdx index of address of HD wallet account
 * @param {string} label label
 * @return {string} success or not
 */
MyWallet.setLabelForAccountAddress = function(accountIdx, addressIdx, label, success, error) {
  if (label != "" && ! MyWallet.isAlphaNumericSpace(label)) {
    error();
  } else {
    WalletStore.getHDWallet().getAccount(accountIdx).setLabelForAddress(addressIdx, label);
    MyWallet.backupWalletDelayed();
    success();
  }
};

MyWallet.getLabeledReceivingAddressesForAccount = function(accountIdx) {
  return WalletStore.getHDWallet().getAccount(accountIdx).getLabeledReceivingAddresses();
};

MyWallet.processTransaction = function(tx) {

  var transaction = {
    from: {account: null, legacyAddresses: null, externalAddresses: null},
    to: {account: null, legacyAddresses: null, externalAddresses: null, email: null, mobile: null},
    fee: 0,
    intraWallet: null
  };


  var legacyAddressWithLargestOutput = undefined;
  var externalAddressWithLargestOutput = undefined;
  var amountFromLegacyAddresses = 0;
  var amountFromExternalAddresses = 0;
  var legacyAddressWithLargestOutputAmount = 0;
  var externalAddressWithLargestOutputAmount = 0;
  var fromAccountIndex = undefined;
  var amountFromAccount = 0;

  for (var i = 0; i < tx.inputs.length; ++i) {
    var isOrigin = false;
    var output = tx.inputs[i].prev_out;
    if (!output || !output.addr)
      continue;

    if (WalletStore.isActiveLegacyAddress(output.addr)) {
      isOrigin = true;
      if (transaction.from.legacyAddresses == null)
        transaction.from.legacyAddresses = [];
      transaction.from.legacyAddresses.push({address: output.addr, amount: output.value});
      transaction.fee += output.value;
    } else {
      for (var j in MyWallet.getAccounts()) {
        var account = WalletStore.getHDWallet().getAccount(j);
        if (!account.isArchived() && output.xpub != null && account.getAccountExtendedKey(false) == output.xpub.m) {
          amountFromAccount += output.value;

          if (! isOrigin) {
            isOrigin = true;
            fromAccountIndex = parseInt(j);

            transaction.fee += output.value;
          } else {
            if ( output.value > legacyAddressWithLargestOutputAmount ) {
              legacyAddressWithLargestOutput = output.addr;
              legacyAddressWithLargestOutputAmount = output.value;
            }
            amountFromLegacyAddresses += output.value;
            transaction.fee += output.value;
          }
          break;
        }
      }

      if (! isOrigin) {
        if ( output.value > externalAddressWithLargestOutputAmount ) {
          externalAddressWithLargestOutput = output.addr;
          externalAddressWithLargestOutputAmount = output.value;
        }
        amountFromExternalAddresses += output.value;
        transaction.fee += output.value;
        transaction.intraWallet = false;
      }
    }

    if(transaction.intraWallet == null) {
      transaction.intraWallet = true;
    }
  }

  if(amountFromExternalAddresses > 0) {
    transaction.from.externalAddresses = {addressWithLargestOutput: externalAddressWithLargestOutput, amount: amountFromExternalAddresses};
  }

  if(amountFromLegacyAddresses > 0) {
    transaction.from.legacyAddresses = {addressWithLargestOutput: legacyAddressWithLargestOutput, amount: amountFromLegacyAddresses};
  }

  if(amountFromAccount > 0) {
    transaction.from.account = {index: fromAccountIndex, amount: amountFromAccount};

  }

  for (var i = 0; i < tx.out.length; ++i) {
    var output = tx.out[i];
    if (!output || !output.addr)
      continue;

    if (WalletStore.isActiveLegacyAddress(output.addr)) {
      if (transaction.to.legacyAddresses == null)
        transaction.to.legacyAddresses = [];

      var isFromLegacyAddresses = false;
      for (var j in transaction.from.legacyAddresses) {
        var addressAmount = transaction.from.legacyAddresses[j];
        if (addressAmount.address == output.addr) {
          addressAmount.amount -= output.value;
          isFromLegacyAddresses = true;
        }
      }
      if (! isFromLegacyAddresses) {
        transaction.to.legacyAddresses.push({address: output.addr, amount: output.value});
      }
      transaction.fee -= output.value;
    } else if (WalletStore.getPaidToDictionary() && (paidToItem = WalletStore.getPaidToDictionary()[tx.hash]) && paidToItem.address == output.addr ) {
      if(paidToItem.email) {
        transaction.to.email = { email: paidToItem.email, redeemedAt: paidToItem.redeemedAt };
      } else if (paidToItem.mobile) {
        transaction.to.mobile = { number: paidToItem.mobile, redeemedAt: paidToItem.redeemedAt };
      };
      transaction.intraWallet = false;
    } else {
      var toAccountSet = false;
      for (var j in MyWallet.getAccounts()) {
        var account = WalletStore.getHDWallet().getAccount(j);
        if (!account.isArchived() && output.xpub != null && account.getAccountExtendedKey(false) == output.xpub.m) {
          if (! toAccountSet) {
            if (transaction.from.account != null && transaction.from.account.index == parseInt(j)) {
              transaction.from.account.amount -= output.value;
            } else {
              transaction.to.account = {index: parseInt(j), amount: output.value};
            }
            toAccountSet = true;
            transaction.fee -= output.value;
          } else {
            if (transaction.from.account != null && transaction.from.account.index == parseInt(j)) {
              transaction.from.account.amount -= output.value;
            } else if ((transaction.to.externalAddresses == null ||
                        output.value > transaction.to.externalAddresses.amount) &&
                       (transaction.from.account != null ||
                        transaction.from.legacyAddresses != null)) {
              transaction.to.externalAddresses = {addressWithLargestOutput: output.addr, amount: output.value};
            }
            transaction.fee -= output.value;
          }
          break;
        }
      }

      if (! toAccountSet) {
        if ((transaction.to.externalAddresses == null ||
             output.value > transaction.to.externalAddresses.amount) &&
            (transaction.from.account != null ||
             transaction.from.legacyAddresses != null)) {
          transaction.to.externalAddresses = {addressWithLargestOutput: output.addr, amount: output.value};
        }
        transaction.fee -= output.value;
        transaction.intraWallet = false;
      }
    }
  }

  if (transaction.from.account == null && transaction.from.legacyAddresses == null) {
    var fromAmount = 0;
    if (transaction.to.account != null)
      fromAmount += transaction.to.account.amount;
    for (var i in transaction.to.legacyAddresses) {
      var addressAmount = transaction.to.legacyAddresses[i];
      fromAmount += addressAmount.amount;
    }
    transaction.from.externalAddresses.amount = fromAmount;
  }

  transaction.hash = tx.hash;

  /* Typically processTransaction() is called directly after transactions
   have been downloaded from the server. In that case you could simply
   reuse tx.confirmations. However processTransaction() can also be
   called at a later time, e.g. if the user keeps their wallet open
   while waiting for a confirmation. */
  transaction.confirmations = MyWallet.getConfirmationsForTx(WalletStore.getLatestBlock(), tx);

  transaction.txTime = tx.time;
  transaction.note = WalletStore.getNote(tx.hash);
  transaction.tags = WalletStore.getTags(tx.hash);
  transaction.size = tx.size;
  transaction.tx_index = tx.txIndex;
  transaction.block_height = tx.blockHeight;

  transaction.result = MyWallet.calculateTransactionResult(transaction);

  return transaction;
};

MyWallet.calculateTransactionResult = function(transaction) {

  var totalOurs = function(toOrFrom) {
    var result = 0;

    if(toOrFrom.account) {
      result = toOrFrom.account.amount;
    } else if (toOrFrom.legacyAddresses && toOrFrom.legacyAddresses.length > 0) {
      for(var i in toOrFrom.legacyAddresses) {
        var legacyAddress = toOrFrom.legacyAddresses[i];
        result += legacyAddress.amount;
      }
    }

    return result;
  };

  var result = 0;

  if (transaction.intraWallet) {
    result = totalOurs(transaction.to);
  } else {
    result = totalOurs(transaction.to) - totalOurs(transaction.from);
  }

  return result;
};

MyWallet.getUnspentOutputsForAddresses = function(addresses, successCallback, errorCallback) {
  BlockchainAPI.get_unspent([addresses], function (obj) {

    obj.unspent_outputs.forEach(function(utxo) {
      var txBuffer = new Buffer(utxo.tx_hash, "hex");
      Array.prototype.reverse.call(txBuffer);
      utxo.hash = txBuffer.toString("hex");
      utxo.index = utxo.tx_output_n;
    });

    successCallback && successCallback(obj.unspent_outputs);
  }, function(e) {
    errorCallback && errorCallback(e.message || e.responseText);
  }, 0, true);
};

MyWallet.getUnspentOutputsForAccount = function(accountIdx, successCallback, errorCallback) {
  var account = WalletStore.getHDWallet().getAccount(accountIdx);

  BlockchainAPI.get_unspent([account.extendedPublicKey], function (obj) {

    obj.unspent_outputs.forEach(function(utxo) {
      var txBuffer = new Buffer(utxo.tx_hash, "hex");
      Array.prototype.reverse.call(txBuffer);
      utxo.hash = txBuffer.toString("hex");
      utxo.index = utxo.tx_output_n;
    });

    successCallback && successCallback(obj.unspent_outputs);
  }, function(e) {
    errorCallback && errorCallback(e.message || e.responseText);
  }, 0, true);
};

MyWallet.recommendedTransactionFeeForAccount = function(accountIdx, amount) {

  if (!WalletStore.isAccountRecommendedFeesValid()) {
    WalletStore.setAmountToRecommendedFee({});
    WalletStore.setIsAccountRecommendedFeesValid(true);
  }

  var recFee = WalletStore.getAmountToRecommendedFee();
  if (recFee === null) {
    recFee = WalletStore.getHDWallet().getAccount(accountIdx).recommendedTransactionFee(amount);
    WalletStore.setAmountToRecommendedFee(amount, recFee);
  }
  return recFee;
};

MyWallet.getBaseFee = function() {
  var network = Bitcoin.networks.bitcoin;
  return network.feePerKb;
};

MyWallet.recommendedTransactionFeeForAddress = function(address, amount) {
  // TODO: calculate the correct fee:
  return MyWallet.getBaseFee();
};

/**
 * @param {function(Array)} successCallback success callback function with transaction array
 * @param {function()} errorCallback error callback function
 * @param {function()} didFetchOldestTransaction callback is called when all transanctions for the specified account has been fetched
 */
MyWallet.fetchMoreTransactionsForAccounts = function(success, error, didFetchOldestTransaction) {

  function getRawTransactionsForAccounts(txOffset, numTx, success, error) {
    var addresses = [];
    for (var i in MyWallet.getAccounts()) {
      var account = WalletStore.getHDWallet().getAccount(i);
      if(!account.isArchived()) {
        addresses.push(account.getAccountExtendedKey(false));
      }
    }

    BlockchainAPI.async_get_history_with_addresses(addresses, function(data) {
      if (success) success(data.txs);
    }, function() {
      if (error) error();

    }, 0, txOffset, numTx);
  }

  getRawTransactionsForAccounts(WalletStore.getHDWallet().numTxFetched, WalletStore.getNumOldTxsToFetchAtATime(), function(data) {
    var processedTransactions = [];

    for (var i in data) {
      var tx = data[i];

      var tx = TransactionFromJSON(data[i]);

      var transaction = MyWallet.processTransaction(tx);
      processedTransactions.push(transaction);
    }

    WalletStore.getHDWallet().numTxFetched += processedTransactions.length;

    if (processedTransactions.length < WalletStore.getNumOldTxsToFetchAtATime()) {
      didFetchOldestTransaction();
    }

    success(processedTransactions);
  }, function(e) {
    error(e);
  });
};

/**
 * @param {number} accountIdx idx of account
 * @param {function(Array)} successCallback success callback function with transaction array
 * @param {function()} errorCallback error callback function
 * @param {function()} didFetchOldestTransaction callback is called when all transanctions for the specified account has been fetched
 */
MyWallet.fetchMoreTransactionsForAccount = function(accountIdx, success, error, didFetchOldestTransaction) {
  function getRawTransactionsForAccount(accountIdx, txOffset, numTx, success, error) {
    var account = WalletStore.getHDWallet().getAccount(accountIdx);
    var accountExtendedPublicKey = account.getAccountExtendedKey(false);

    BlockchainAPI.async_get_history_with_addresses([accountExtendedPublicKey], function(data) {
      if (success) success(data);
    }, function() {
      if (error) error();

    }, 0, txOffset, numTx);
  }

  var account = WalletStore.getHDWallet().getAccount(accountIdx);
  getRawTransactionsForAccount(accountIdx, account.numTxFetched, WalletStore.getNumOldTxsToFetchAtATime(), function(data) {
    var processedTransactions = [];

    for (var i in data.txs) {
      var tx = data.txs[i];

      var tx = TransactionFromJSON(data.txs[i]);

      var transaction = MyWallet.processTransaction(tx);

      processedTransactions.push(transaction);
    }


    account.numTxFetched += processedTransactions.length;

    if (processedTransactions.length < WalletStore.getNumOldTxsToFetchAtATime()) {
      didFetchOldestTransaction();
    }

    success(processedTransactions, data.wallet.final_balance);
  }, function(e) {
    error(e);
  });
};

// Reads from and writes to global paidTo
MyWallet.checkForRecentlyRedeemed = function() {
  var paidToAddressesToMonitor = [];

  for (var tx_hash in WalletStore.getPaidToDictionary()) {
    var localPaidTo = WalletStore.getPaidToDictionary()[tx_hash];
    if (localPaidTo.redeemedAt == null) {
      paidToAddressesToMonitor.push(localPaidTo.address);
    }
  }

  if(paidToAddressesToMonitor.length == 0)
    return;

  MyWallet.fetchRawTransactionsAndBalanceForAddresses(paidToAddressesToMonitor, function(transactions, balances) {
    for(var i in balances) {
      if(balances[i].final_balance == 0 && balances[i].n_tx > 0) {

        var redeemedAt = null;

        // Find corresponding transaction:
        for(var j in transactions) {
          for(var k in transactions[j].inputs) {
            if(balances[i].address === transactions[j].inputs[k].prev_out.addr) {
              // Set redeem time
              redeemedAt = transactions[j].time;
            }
          }
        }

        // Mark as redeemed:
        for(var tx_hash in WalletStore.getPaidToDictionary()) {
          var paidToEntry = WalletStore.getPaidToDictionary()[tx_hash];
          if(balances[i].address === paidToEntry.address) {
            WalletStore.markPaidToEntryRedeemed(tx_hash, redeemedAt || 1);
            MyWallet.backupWalletDelayed();
            // If redeem time not known, set to default time.
          }
        }

      }
    }
  }, function() {
    console.log("Could not check if email/sms btc have been redeemed.");
  });
};


/**
 * @param {string} privatekey private key to redeem
 * @param {function()} successCallback success callback function with balance in satoshis
 * @param {function()} errorCallback error callback function
 */
MyWallet.getBalanceForRedeemCode = function(privatekey, successCallback, errorCallback)  {
  var format = MyWallet.detectPrivateKeyFormat(privatekey);
  if(format == null) {
    errorCallback("Unkown private key format");
    return;
  }
  var privateKeyToSweep = MyWallet.privateKeyStringToKey(privatekey, format);
  var from_address_compressed = MyWallet.getCompressedAddressString(privateKeyToSweep);
  var from_address_uncompressed = MyWallet.getUnCompressedAddressString(privateKeyToSweep);


  BlockchainAPI.get_balance([from_address_compressed, from_address_uncompressed], function(value) {
    if (successCallback)
      successCallback(value);
  }, function() {
    WalletStore.sendEvent("msg", {type: "error", message: 'Error Getting Address Balance'});
    if (errorCallback)
      errorCallback();
  });
};

/**
 * Redeem bitcoins sent from email or mobile.
 * @param {number} accountIdx index of HD wallet account
 * @param {string} privatekey private key to redeem
 * @param {function()} successCallback success callback function
 * @param {function()} errorCallback error callback function
 */
MyWallet.redeemFromEmailOrMobile = function(accountIdx, privatekey, successCallback, errorCallback)  {
  var account = this.getAccount(accountIdx);

  try {
    var format = MyWallet.detectPrivateKeyFormat(privatekey);
    var privateKeyToSweep = MyWallet.privateKeyStringToKey(privatekey, format);
    var from_address_compressed = MyWallet.getCompressedAddressString(privateKeyToSweep);
    var from_address_uncompressed = MyWallet.getUnCompressedAddressString(privateKeyToSweep);

    MyWallet.getUnspentOutputsForAddresses(
      [from_address_compressed, from_address_uncompressed],
      function (unspent_outputs) {
        var values = unspent_outputs.map(function(unspent) {
          return unspent.value;
        });
        var amount = values.reduce(function(a, b) {
          return a + b;
        });

        var fee = MyWallet.getBaseFee();
        amount = amount - fee;

        var toAddress = account.getReceivingAddress();

        // No change address needed - amount will be consumed in full
        var changeAddress = null;

        var listener = null;

        var tx = new Transaction(unspent_outputs, toAddress, amount, fee, changeAddress, listener);

        var keys = [privatekey];
        if (tx.addressesOfNeededPrivateKeys.length === 2) {
          keys.push(privatekey);
        }

        tx.addPrivateKeys(keys);

        var signedTransaction = tx.sign();

        BlockchainAPI.push_tx(signedTransaction, null, successCallback, errorCallback);
      });
  } catch (e) {
    console.log(e);
    WalletStore.sendEvent("msg", {type: "error", message: 'Error Decoding Private Key. Could not claim coins.'});
  }
};

/**
 * @param { Array } list of addresses
 * @param {function():Array} successCallback success callback function with transaction array
 * @param {function()} errorCallback callback function
 */
MyWallet.fetchRawTransactionsAndBalanceForAddresses = function(addresses, success, error) {
  BlockchainAPI.async_get_history_with_addresses(addresses, function(data) {
    if (success) success( data.txs, data.addresses);
  }, function() {
    if (error) error();

  }, 0, 0);
};

/**
 * @param {function():Array} successCallback success callback function with transaction array
 * @param {function()} errorCallback callback function
 * @param {function()} didFetchOldestTransaction callback is called when all transanctions for legacy addresses have been fetched
 */
MyWallet.fetchMoreTransactionsForLegacyAddresses = function(success, error, didFetchOldestTransaction) {
  function getRawTransactionsForLegacyAddresses(txOffset, numTx, success, error) {
    var allAddresses = WalletStore.getLegacyActiveAddresses();

    BlockchainAPI.async_get_history_with_addresses(allAddresses, function(data) {
      if (success) success(data.txs);
    }, function() {
      if (error) error();

    }, 0, txOffset, numTx);
  }

  getRawTransactionsForLegacyAddresses(WalletStore.getLegacyAddressesNumTxFetched(), WalletStore.getNumOldTxsToFetchAtATime(), function(data) {
    var processedTransactions = [];

    for (var i in data) {
      var tx = data[i];

      var tx = TransactionFromJSON(data[i]);

      var transaction = MyWallet.processTransaction(tx);
      processedTransactions.push(transaction);
    }

    WalletStore.addLegacyAddressesNumTxFetched(processedTransactions.length);

    if (processedTransactions.length < WalletStore.getNumOldTxsToFetchAtATime()) {
      didFetchOldestTransaction();
    }

    success(processedTransactions);

  }, function(e) {
    console.log('error ' + e);
  });
};

MyWallet.archiveAccount = function(idx) {
  var account = WalletStore.getHDWallet().getAccount(idx);
  account.setIsArchived(true);
  MyWallet.backupWalletDelayed();
};

/**
 * @param {number} accountIdx index of account
 * @param {?function(number)} successcallback success callback function with account balance
 */
MyWallet.unarchiveAccount = function(idx, successcallback) {
  var archivedAccount = WalletStore.getHDWallet().getAccount(idx);

  var account = new HDAccount(null, null, archivedAccount.label, idx);
  account.newNodeFromExtKey(archivedAccount.extendedPublicKey);

  account.generateCache();

  account.extendedPrivateKey = archivedAccount.extendedPrivateKey;
  account.extendedPublicKey = archivedAccount.extendedPublicKey;

  WalletStore.getHDWallet().replaceAccount(idx, account);


  MyWallet.fetchMoreTransactionsForAccount(idx,function(txs, balance) {
    account.setBalance(balance);

    MyWallet.listenToHDWalletAccount(account.extendedPrivateKey);

    if (successcallback) {
      successcallback(txs);
    }
  }, function(error) {
    console.log("Failed to fetch transactions");
  }, function() {});

  MyWallet.backupWalletDelayed();
};

/**
 * @return {Array} Array of HD accounts
 */
MyWallet.getAccounts = function() {
  if (!WalletStore.didUpgradeToHd()) {
    return [];
  }
  return WalletStore.getHDWallet().getAccounts();
};

/**
 * @param {number} idx of account
 * @return {Object} Account at index
 */
MyWallet.getAccount = function(idx) {
  return WalletStore.getHDWallet().getAccount(idx);
};

/**
 * @return {Number} Number of HD accounts
 */
MyWallet.getAccountsCount = function() {
  if (!WalletStore.didUpgradeToHd()) {
    return 0;
  }
  return WalletStore.getHDWallet().getAccountsCount();
};

/**
 * Create new account and backup wallet
 * @param {string} label label name
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 * @param {function()} success called when account creation was successful
 * @param {function()} error called when account creation failed
 */
MyWallet.createAccount = function(label, getPassword, success, error) {
  if(!this.validateAccountLabel(label)) {
    error("Invalid label");
    return;
  }

  if (WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, incorrect_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        createAccount(label, pw, success, error);
      } else {
        incorrect_password();
        error();
      }
    });
  } else {
    createAccount(label, null, success, error);
  }
};

// Assumes second password is needed if the argument is not null.
function createAccount(label, second_password, success, error) {
  var account = WalletStore.getHDWallet().createAccount(label, second_password);
  var accountExtendedPublicKey = account.getAccountExtendedKey(false);
  account.setBalance(0);
  MyWallet.listenToHDWalletAccount(accountExtendedPublicKey);
  success();
  MyWallet.backupWalletDelayed();
}

/**
 * @param {string} mnemonic mnemonic
 * @return {boolean} is valid mnemonic
 */
MyWallet.isValidateBIP39Mnemonic = function(mnemonic) {
  return BIP39.validateMnemonic(mnemonic);
};

/**
 * Recover HD wallet from passphrase by recreating all accounts and querying the balance of all accounts and addresses
 * @param {string} seedHex passphrase seed in hex
 * @param {?string} bip39Password bip39 Password
 * @param {function()} getPassword
 * @param {function()} successCallback success callback function
 * @param {function()} errorCallback error callback function
 */
// TODO looks broken - where does passphrase come from?
MyWallet.recoverMyWalletHDWalletFromSeedHex = function(seedHex, bip39Password, getPassword, successCallback, errorCallback) {
  function recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, secondPassword, successCallback, errorCallback) {
    HDWallet.recoverHDWalletFromSeedHex(seedHex, bip39Password, secondPassword, function(hdWallet) {
      WalletStore.setHDWallet(hdWallet);

      if (successCallback)
        successCallback();

      MyWallet.backupWalletDelayed('update', function() {
        MyWallet.get_history();
      });
    }, function() {
      if (errorCallback)
        errorCallback();
    });
  }

  if (WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, wrong_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, pw, successCallback, errorCallback);
      } else {
        wrong_password();
        errorCallback();
      }
    });
  } else {
    recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, null, successCallback, errorCallback);
  }
};

/**
 * Recover HD wallet from mnemonic by recreating all accounts and querying the balance of all accounts and addresses
 * @param {string} passphrase seed in words
 * @param {?string} bip39Password
 * @param {function()} getPassword
 * @param {function()=} successCallback success callback function
 * @param {function()=} errorCallback error callback function
 */
MyWallet.recoverMyWalletHDWalletFromMnemonic = function(passphrase, bip39Password, getPassword, successCallback, errorCallback) {
  if(bip39Password == undefined || bip39Password == null) {
    bip39Password = "";
  }
  
  function recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, secondPassword, successCallback, errorCallback) {
    HDWallet.recoverHDWalletFromMnemonic(passphrase, bip39Password, secondPassword, function(hdWallet) {
      WalletStore.setHDWallet(hdWallet);

      if (successCallback)
        successCallback();

      MyWallet.backupWalletDelayed('update', function() {
        MyWallet.get_history();
      });
    }, function() {
      if (errorCallback)
        errorCallback();
    });
  }

  if (WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, wrong_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, pw, successCallback, errorCallback);
      } else {
        wrong_password();
        errorCallback();
      }
    });
  } else {
    recoverMyWalletHDWalletFromMnemonic(passphrase, bip39Password, null, successCallback, errorCallback);
  }
};

MyWallet.listenToHDWalletAccount = function(accountExtendedPublicKey) {
  try {
    var msg = '{"op":"xpub_sub", "xpub":"'+ accountExtendedPublicKey +'"}';
    ws.send(msg);
  } catch (e) { }
};

MyWallet.listenToHDWalletAccounts = function() {
  for (var i in MyWallet.getAccounts()) {
    var account = WalletStore.getHDWallet().getAccount(i);
    if(!account.isArchived()) {
      var accountExtendedPublicKey = account.getAccountExtendedKey(false);
      MyWallet.listenToHDWalletAccount(accountExtendedPublicKey);
    }
  }
};

MyWallet.buildHDWallet = function(seedHexString, accountsArrayPayload, bip39Password, secondPassword, successCallback, errorCallback) {
  assert.notEqual(seedHexString, undefined, "Seed hex string required");
  assert.notEqual(seedHexString, null, "Seed hex string required");
  assert(accountsArrayPayload, "Accounts payload missing");
  // bip39Password, secondPassword are optional
  assert(successCallback, "Success callback required()");
  
  var _success = function(hdWallet) {
    WalletStore.setHDWallet(hdWallet);
    successCallback && successCallback(hdWallet);
  };

  HDWallet.buildHDWallet(seedHexString, accountsArrayPayload, bip39Password, secondPassword, _success, errorCallback);
};

MyWallet.generateHDWalletPassphrase = function() {
  return BIP39.generateMnemonic();
};

MyWallet.generateHDWalletSeedHex = function() {
  var passPhrase = MyWallet.generateHDWalletPassphrase();
  return BIP39.mnemonicToEntropy(passPhrase);
};

MyWallet.deleteHDWallet = function(successCallback, errorCallback) {
  if(WalletStore.getHDWallet == undefined || WalletStore.getHDWallet() == null) {
    if (successCallback)
      successCallback();
    return;
  }
  WalletStore.setHDWallet(null);
  MyWallet.backupWallet('update', function() {
    if (successCallback)
      successCallback();
  }, function() {
    if (errorCallback)
      errorCallback();
  });
};

/**
 * Upgrade legacy wallet to HD wallet.
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 * @param {?function()=} success Success callback function.
 * @param {?function()=} error Error callback function.
 */
MyWallet.upgradeToHDWallet = function(getPassword, success, error) {
  if (WalletStore.didUpgradeToHd()) {
    success && success();
    return;
  }

  var _success = function() {
    MyWallet.backupWalletDelayed('update');

    success && success();
  };

  var _error = function () {
    error && error();
  };

  MyWallet.initializeHDWallet(null, "", getPassword, _success, _error);
};

/**
 * Initialize HD wallet and create "Spending" account.
 * @param {?string} passphrase HD passphrase to generate the seed. If null, a seed will be generated.
 * @param {?string} bip39Password Password to protect the seed when generating seed from mnemonic.
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 * @param {function()} success Success callback function.
 * @param {function()} error Error callback function.
 */
MyWallet.initializeHDWallet = function(passphrase, bip39Password, getPassword, success, error)  {
  function initializeHDWallet(passphrase, bip39Password, second_password, success, error) {
    WalletStore.setDidUpgradeToHd(true);
    var seedHexString;

    if (passphrase) {
      seedHexString = BIP39.mnemonicToEntropy(passphrase);
    }
    else {
      seedHexString = MyWallet.generateHDWalletSeedHex();
    }

    var _success = function () {
      var account = WalletStore.getHDWallet().createAccount("Spending", second_password);

      account.setBalance(0);

      MyWallet.listenToHDWalletAccount(account.getAccountExtendedKey(false));

      success();
    };

    MyWallet.buildHDWallet(seedHexString, [], bip39Password, second_password, _success, error);
  }

  if (WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, wrong_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        initializeHDWallet(passphrase, bip39Password, pw, success, error);
      } else {
        wrong_password();
        error();
      }
    });

  } else {
    initializeHDWallet(passphrase, bip39Password, null,  success, error);
  }
};

/**
 * @param {function(function(string, function, function))} getPassword Get the second password: takes one argument, the callback function, which is called with the password and two callback functions to inform the getPassword function if the right or wrong password was entered.
 * @param {function(string)} success Callback with the passphrase
 * @param {function(string)} error Callback with reason for failure
 */
MyWallet.getHDWalletPassphraseString = function(getPassword, successCallback, errorCallback) {
  if (WalletStore.getDoubleEncryption()) {
    getPassword(function(pw, correct_password, incorrect_password) {
      if (MyWallet.validateSecondPassword(pw)) {
        correct_password();
        var seed = WalletCrypto.decryptSecretWithSecondPassword(WalletStore.getHDWallet().getSeedHexString(), pw, WalletStore.getSharedKey(), WalletStore.getPbkdf2Iterations());
        successCallback(WalletStore.getHDWallet().getPassphraseString(seed));
      } else {
        incorrect_password();
        errorCallback();
      }
    });
  } else {
    var seed = WalletStore.getHDWallet().getSeedHexString();
    successCallback(
      WalletStore.getHDWallet().getPassphraseString(seed)
    );
  }
};

/**
 * @param {string} candidate candidate address
 * @return {boolean} is valid address
 */
MyWallet.isValidAddress = function(candidate) {
  try {
    Bitcoin.Address.fromBase58Check(candidate);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * @param {string} candidate candidate PrivateKey
 * @return {boolean} is valid PrivateKey
 */
MyWallet.isValidPrivateKey = function(candidate) {
  try {
    var format = MyWallet.detectPrivateKeyFormat(candidate);
    if(format == "bip38") { return true }
    var key = MyWallet.privateKeyStringToKey(candidate, format);
    return key.pub.getAddress().toString();
  } catch (e) {
    return false;
  }
};

MyWallet.makeWalletJSON = function(format) {
  return MyWallet.makeCustomWalletJSON(format, WalletStore.getGuid(), WalletStore.getSharedKey());
};

MyWallet.makeCustomWalletJSON = function(format, guid, sharedKey) {

  var encode_func = noConvert;

  if (format == 'base64')
    encode_func = base58ToBase64;
  else if (format == 'hex')
    encode_func = base58ToHex;
  else if (format == 'sipa')
    encode_func = MyWallet.base58ToSipa;
  else if (format == 'base58')
    encode_func = base58ToBase58;

  var out = '{\n  "guid" : "'+guid+'",\n  "sharedKey" : "'+sharedKey+'",\n';

  if (WalletStore.getDoubleEncryption() && WalletStore.getDPasswordHash() != null && encode_func == noConvert) {
    out += '  "double_encryption" : '+WalletStore.getDoubleEncryption()+',\n  "dpasswordhash" : "'+WalletStore.getDPasswordHash()+'",\n';
  }

  if (WalletStore.getWalletOptions()) {
    out += '  "options" : ' + JSON.stringify(WalletStore.getWalletOptions())+',\n';
  }

  out += '  "keys" : [\n';

  var atLeastOne = false;

  //TODO: this probably needs to be a small addressesToJSON
  // This functions should be divided in small converters and then composed
  var addresses = WalletStore.getAddresses();
  for (var key in addresses) {
    var addr = $.extend({}, addresses[key]);

    if (addr.tag == 1) {
      delete addr.tag;
    }

    if (addr.priv != null) {
      addr.priv = encode_func(addr.priv, addr.addr);
    }

    //Delete null values
    for (var i in addr) {
      if (addr[i] === null || addr[i] === undefined) {
        delete addr[i];
      }
    }

    //balance property should not be saved
    delete addr.balance;

    out += '    ' + JSON.stringify(addr) + ',\n';

    atLeastOne = true;
  }

  if (atLeastOne) {
    out = out.substring(0, out.length-2);
  }

  out += "\n  ]";


  if (nKeys(WalletStore.getAddressBook()) > 0) {
    out += ',\n  "address_book" : [\n';

    for (var key in WalletStore.getAddressBook()) {
      out += '    {"addr" : "'+ key +'",\n';
      out += '     "label" : "'+ WalletStore.getAddressBookLabel(key) + '"},\n';
    }

    //Remove the extra comma
    out = out.substring(0, out.length-2);

    out += "\n  ]";
  }

  if (nKeys(WalletStore.getNotes()) > 0) {
    out += ',\n  "tx_notes" : ' + JSON.stringify(WalletStore.getNotes());
  }

  if (nKeys(WalletStore.getAllTags()) > 0) {
    out += ',\n  "tx_tags" : ' + JSON.stringify(WalletStore.getAllTags());
  }

  if (WalletStore.getTagNames() != null) {
    out += ',\n  "tag_names" : ' + JSON.stringify(WalletStore.getTagNames());
  }

  if (WalletStore.getHDWallet() != null) {

    out += ',\n  "hd_wallets" : [\n';

    out += '    {\n';
    out += '      "seed_hex" : "'+ WalletStore.getHDWallet().getSeedHexString() +'",\n';
    out += '      "passphrase" : "'+ WalletStore.getHDWallet().getBip39Password() +'",\n';
    out += '      "mnemonic_verified" : '+ WalletStore.isMnemonicVerified() +',\n';
    out += '      "default_account_idx" : '+ WalletStore.getDefaultAccountIndex() +',\n';
    if (WalletStore.getPaidToDictionary() != null) {
      out += '      "paidTo" : ' + JSON.stringify(WalletStore.getPaidToDictionary()) +',\n';
    }

    out += '      "accounts" : [\n';

    for (var i in MyWallet.getAccounts()) {
      var account = WalletStore.getHDWallet().getAccount(i);

      var accountJsonData = account.getAccountJsonData();
      out += '        ' + JSON.stringify(accountJsonData);
      if (i < MyWallet.getAccountsCount() - 1) {
        out += ",\n";
      }
    }
    out += "\n      ]";
    out += '\n    }';

    out += "\n  ]";
  }

  out += '\n}';

  return out;
};

MyWallet.get_history_with_addresses = function(addresses, success, error) {
  BlockchainAPI.get_history_with_addresses(addresses, function(data) {
    if (success) success(data);
  }, function() {
    if (error) error();

  }, 0, 0, WalletStore.getNTransactionsPerPage());
};

MyWallet.get_history = function(success, error) {
  BlockchainAPI.get_history(function(data) {

    parseMultiAddressJSON(data, false, false);

    success && success();

  }, function() {
    error && error();

  }, 0, 0, WalletStore.getNTransactionsPerPage());
};

MyWallet.getConfirmationsForTx = function(latest_block, tx) {
  if (latest_block && tx.blockHeight != null && tx.blockHeight > 0) {
    return latest_block.height - tx.blockHeight + 1;
  } else {
    tx.setConfirmations(0);
    return 0;
  }
};

// Must allow the following characters:
// + : needed for sent to phone number labels
MyWallet.isAlphaNumericSpace = function (input) {
  return XRegExp("^\\p{L}[\\p{L}@ \\-,._']*$").test(input) || /^[\w\-+,._  ]+$/.test(input);
};

function parseMultiAddressJSON(obj, cached, checkCompleted) {
  var transactions = WalletStore.getTransactions();
  if (!cached) {

    WalletStore.setMixerFee(obj.mixer_fee);
    WalletStore.setRecommendIncludeFee(obj.recommend_include_fee);

    if (obj.info) {
      if (obj.info.symbol_local)
        setLocalSymbol(obj.info.symbol_local);

      if (obj.info.symbol_btc)
        setBTCSymbol(obj.info.symbol_btc);

      if (obj.info.notice)
        WalletStore.sendEvent("msg", {type: "error", message: obj.info.notice});
    }
  }

  if (obj.disable_mixer) {
    //$('#shared-addresses,#send-shared').hide();
  }

  WalletStore.setSharedcoinEndpoint(obj.sharedcoin_endpoint);

  transactions.length = 0;

  if (obj.wallet == null) {
    WalletStore.setTotalReceived(0);
    WalletStore.setTotalSent(0);
    WalletStore.setFinalBalance(0);
    WalletStore.setNTransactions(0);
    return;
  }

  WalletStore.setTotalReceived(obj.wallet.total_received);
  WalletStore.setTotalSent(obj.wallet.total_sent);
  WalletStore.setFinalBalance(obj.wallet.final_balance);
  WalletStore.setNTransactions(obj.wallet.n_tx);

  for (var i = 0; i < obj.addresses.length; ++i) {
    if (WalletStore.legacyAddressExists(obj.addresses[i].address)) {
      WalletStore.setLegacyAddressBalance(obj.addresses[i].address, obj.addresses[i].final_balance);
      // addresses[obj.addresses[i].address].balance = obj.addresses[i].final_balance;
    }

    for (var j in MyWallet.getAccounts()) {
      var account = WalletStore.getHDWallet().getAccount(j);

      if(!account.isArchived()) {
        var extPubKey = account.getAccountExtendedKey(false);

        if (extPubKey == obj.addresses[i].address) {
          account.setBalance(obj.addresses[i].final_balance);
          account.n_tx = obj.addresses[i].n_tx;
        }
      }
    }
  }

  WalletStore.setIsAccountRecommendedFeesValid(false);
  for (var i = 0; i < obj.txs.length; ++i) {
    var tx = TransactionFromJSON(obj.txs[i]);
    
    WalletStore.pushTransaction(tx);
  }

  if (!cached) {
    if (obj.info.latest_block)
      WalletStore.setLatestBlock(obj.info.latest_block);
  }

  WalletStore.sendEvent('did_multiaddr');
}

function didDecryptWallet(success) {

  //We need to check if the wallet has changed
  MyWallet.getWallet();

  var log_time_out = setTimeout(MyWallet.logout, WalletStore.getLogoutTime());
  WalletStore.setLogoutTimeout(log_time_out);

  success();
}

/**
 * Get the list of transactions from the http API.
 * Needs to be called by client in the success callback of fetchWalletJson and after MyWallet.initializeHDWallet
 * @param {function()=} success Success callback function.
 */
MyWallet.getHistoryAndParseMultiAddressJSON = function(_success) {
  var success = function() {
    _success && _success();
  };

  var error = function() {
    MyStore.get('multiaddr', function(multiaddrjson) {
      if (multiaddrjson != null) {
        parseMultiAddressJSON($.parseJSON(multiaddrjson), true, false);
        _success && _success();
      }
    });
  };

  var addresses = WalletStore.getXpubs().concat(WalletStore.getLegacyActiveAddresses());
  BlockchainAPI.async_get_history_with_addresses(addresses, function(data) {
    parseMultiAddressJSON(data, false, false);
    success && success();
  }, function() {
    error && error();
  }, 0, 0, WalletStore.getNTransactionsPerPage());
};

function checkWalletChecksum(payload_checksum, success, error) {
  var data = {method : 'wallet.aes.json', format : 'json', checksum : payload_checksum};

  MyWallet.securePost("wallet", data, function(obj) {
    if (!obj.payload || obj.payload == 'Not modified') {
      if (success) success();
    } else if (error) error();
  }, function(e) {
    if (error) error();
  });
}

//Fetch a new wallet from the server
//success(modified true/false)
MyWallet.getWallet = function(success, error) {
  var data = {method : 'wallet.aes.json', format : 'json'};

  if (WalletStore.getPayloadChecksum() && WalletStore.getPayloadChecksum().length > 0)
    data.checksum = WalletStore.getPayloadChecksum();

  MyWallet.securePost("wallet", data, function(obj) {
    if (!obj.payload || obj.payload == 'Not modified') {
      if (success) success();
      return;
    }

    WalletStore.setEncryptedWalletData(obj.payload);

    internalRestoreWallet(function() {
      MyWallet.get_history();

      if (success) success();
    }, function() {
      if (error) error();
    });
  }, function(e) {
    if (error) error();
  });
};

function internalRestoreWallet(success, error, decrypt_success, build_hd_success) {
  assert(success, 'Success callback required');
  assert(error, 'Error callback required');
  assert(decrypt_success, 'Decrypt success callback required');
  assert(build_hd_success, 'Build HD success callback required');
  
  var encryptedWalletData = WalletStore.getEncryptedWalletData();
  
  if (encryptedWalletData == null || encryptedWalletData.length == 0) {
    error('No Wallet Data To Decrypt');
    return;
  }
  
  WalletCrypto.decryptWallet( 
    encryptedWalletData, 
    WalletStore.getPassword(), 
    function(obj, rootContainer) {   
      
      decrypt_success();
      
      WalletStore.setSharedKey(obj.sharedKey);
      var sharedKey = WalletStore.getSharedKey();

      if (!sharedKey || sharedKey.length == 0 || sharedKey.length != 36) {
        throw 'Shared Key is invalid';
      }

      if (rootContainer) {
        WalletStore.setPbkdf2Iterations(rootContainer.pbkdf2_iterations);
      }                

      if (obj.double_encryption && obj.dpasswordhash) {
        WalletStore.setDoubleEncryption(obj.double_encryption);
        WalletStore.setDPasswordHash(obj.dpasswordhash);
      }

      if (obj.options) {
        $.extend(WalletStore.getWalletOptions(), obj.options);
      }

      WalletStore.newLegacyAddressesFromJSON(obj.keys);        

      WalletStore.newAddressBookFromJSON(obj.address_book);

      if (obj.hd_wallets && obj.hd_wallets.length > 0) {
        WalletStore.setDidUpgradeToHd(true);
        var defaultHDWallet = obj.hd_wallets[0];
        
        if (!WalletStore.isHaveBuildHDWallet()) {
          WalletStore.setEmptyXpubs();
          for (var i in defaultHDWallet.accounts) {
            var account  = defaultHDWallet.accounts[i];

            if(!account.archived) {
              WalletStore.pushXpub(account.xpub);
            }
          }
          
          // We're not passing a bip39 or second password
          MyWallet.buildHDWallet(
            defaultHDWallet.seed_hex, 
            defaultHDWallet.accounts, 
            defaultHDWallet.passphrase || "", 
            undefined, 
            build_hd_success, 
            function() {console.log("Error");}
          );
          
          WalletStore.setHaveSetServerTime(true);
        }
        
        if (defaultHDWallet.mnemonic_verified) {
          WalletStore.setMnemonicVerified(defaultHDWallet.mnemonic_verified);
        } else {
          WalletStore.setMnemonicVerified(false);
        }

        WalletStore.setDefaultAccountIndex(defaultHDWallet.default_account_idx);

        if (defaultHDWallet.paidTo != null) {
          WalletStore.setPaidTo(defaultHDWallet.paidTo);
          MyWallet.checkForRecentlyRedeemed(defaultHDWallet.paidTo);
        }
        
      } else {
        WalletStore.setDidUpgradeToHd(false);
        WalletStore.sendEvent('hd_wallets_does_not_exist');
      }        

      if (obj.tx_notes) {
        for (var tx_hash in obj.tx_notes) {
          var note = obj.tx_notes[tx_hash];
          WalletStore.setNote(tx_hash, note);
        }
      }                

      WalletStore.setTags(obj.tx_tags);
      WalletStore.setTagNames(obj.tag_names);
      
      //If we don't have a checksum then the wallet is probably brand new - so we can generate our own
      if (WalletStore.getPayloadChecksum() == null || WalletStore.getPayloadChecksum().length == 0) {
        WalletStore.setPayloadChecksum(WalletStore.generatePayloadChecksum());
      }
      
      setIsInitialized();

      success();
    }, 
    error
  );
}

MyWallet.makePairingCode = function(success, error) {
  try {
    MyWallet.securePost('wallet', { method : 'pairing-encryption-password' }, function(encryption_phrase) {
      success('1|' + WalletStore.getGuid() + '|' + WalletCrypto.encrypt(WalletStore.getSharedKey() + '|' + CryptoJS.enc.Utf8.parse(WalletStore.getPassword()).toString(), encryption_phrase, 10));
    }, function(e) {
      error(e);
    });
  } catch (e) {
    error(e);
  }
};

/**
 * Fetch information on wallet identfier with resend code set to true
 * @param {string} user_guid User GUID.
 * @param {function()} success Success callback function.
 * @param {function()} error Error callback function.
 */

MyWallet.resendTwoFactorSms = function(user_guid, success, error) {
  $.ajax({
    type: "GET",
    dataType: 'json',
    url: BlockchainAPI.getRootURL() + 'wallet/'+user_guid,
    xhrFields: {
      withCredentials: true
    },
    crossDomain: true,
    data : {
      format : 'json',
      resend_code : 1,
      ct : (new Date()).getTime(),
      api_code : WalletStore.getAPICode(),
      shared_key: WalletStore.getSharedKey()
    },
    timeout: 60000,
    success: function(obj) {
      success();
    },
    error : function(e) {
      if(e.responseJSON && e.responseJSON.initial_error) {
        error(e.responseJSON.initial_error);
      } else {
        error();
      }
    }
  })
};


/**
 * Fetch wallet from server, decrypt and build wallet model.
 * @param {string} user_guid User GUID.
 * @param {?string} shared_key User shared key.
 * @param {bool} resend_code Whether this is a resend or not.
 * @param {string} inputedPassword User password.
 * @param {?string} twoFACode User 2 factor code.
 * @param {function()} success Success callback function.
 * @param {function(number)} needs_two_factor_code Require 2 factor code callback function.
 * @param {function()} wrong_two_factor_code 2 factor code incorrect callback function.
 * @param {function()} other_error Other error callback function.
 * @param {function()=} fetch_success Called when wallet was fetched successfully.
 * @param {function()=} decrypt_success Called when wallet was decrypted successfully.
 * @param {function()=} build_hd_success Called when the HD part of the wallet was initialized successfully.
 */
MyWallet.fetchWalletJson = function(user_guid, shared_key, resend_code, inputedPassword, twoFACode, success, needs_two_factor_code, wrong_two_factor_code, authorization_required, other_error, fetch_success, decrypt_success, build_hd_success) {
  assert(success, 'Success callback required');
  assert(other_error, 'Error callback required');
  assert(decrypt_success, 'Decrypt success callback required');
  assert(build_hd_success, 'Build HD success callback required');
  
  if (!resend_code && WalletStore.isDidSetGuid()) {
    MyWallet.restoreWallet(inputedPassword, twoFACode, success, wrong_two_factor_code, other_error, decrypt_success, build_hd_success);
    return;
  }

  if (isInitialized) {
    other_error('Cannot Set GUID Once Initialized');
    return;
  }

  WalletStore.setGuid(user_guid);
  WalletStore.setSharedKey(shared_key);
  var sharedKey = WalletStore.getSharedKey();

  var clientTime=(new Date()).getTime();
  var data = {format : 'json', resend_code : resend_code, ct : clientTime};

  if (WalletStore.getPayloadChecksum()) {
    data.checksum = WalletStore.getPayloadChecksum();
  }

  if (sharedKey) {
    data.sharedKey = sharedKey;
  }

  data.api_code = WalletStore.getAPICode();

  $.ajax({
    type: "GET",
    dataType: 'json',
    url: BlockchainAPI.getRootURL() + 'wallet/'+user_guid,
    // contentType: "application/json; charset=utf-8",
    xhrFields: {
      withCredentials: true
    },
    crossDomain: true,
    data : data,
    timeout: 60000,
    success: function(obj) {
      fetch_success && fetch_success();

      MyWallet.handleNTPResponse(obj, clientTime);

      if (!obj.guid) {
        WalletStore.sendEvent("msg", {type: "error", message: 'Server returned null guid.'});
        other_error('Server returned null guid.');
        return;
      }

      WalletStore.setGuid(obj.guid);
      WalletStore.setAuthType(obj.auth_type);
      WalletStore.setRealAuthType(obj.real_auth_type);
      WalletStore.setSyncPubKeys(obj.sync_pubkeys);

      if (obj.payload && obj.payload.length > 0 && obj.payload != 'Not modified') {
        WalletStore.setEncryptedWalletData(obj.payload);
      } else {
        WalletStore.setDidSetGuid();
        needs_two_factor_code(WalletStore.get2FAType());
        return;
      }
      
      war_checksum = obj.war_checksum;

      setLocalSymbol(obj.symbol_local);

      setBTCSymbol(obj.symbol_btc);

      if (obj.initial_error) {
        WalletStore.sendEvent("msg", {type: "error", message: obj.initial_error});
      }

      if (obj.initial_success) {
        WalletStore.sendEvent("msg", {type: "success", message: obj.initial_success});
      }

      MyStore.get('guid', function(local_guid) {
        if (local_guid != WalletStore.getGuid()) {
          MyStore.remove('guid');
          MyStore.remove('multiaddr');
          MyStore.remove('payload');

          //Demo Account Guid
          if (!WalletStore.isDemoWallet()) {
            MyStore.put('guid', WalletStore.getGuid());
          }
        }
      });
      
      if (obj.language && WalletStore.getLanguage() != obj.language) {
        WalletStore.setLanguage(obj.language);
      }

      WalletStore.setDidSetGuid();
      MyWallet.restoreWallet(inputedPassword, twoFACode, success, wrong_two_factor_code, other_error, decrypt_success, build_hd_success);
    },
    error : function(e) {
      if(e.responseJSON && e.responseJSON.initial_error && !e.responseJSON.authorization_required) {
        other_error(e.responseJSON.initial_error);
        return;
      }

      WalletStore.sendEvent('did_fail_set_guid');

      var obj = $.parseJSON(e.responseText);

      if (obj.authorization_required && typeof(authorization_required) === "function") {
        authorization_required(function(authorization_received) {
          MyWallet.pollForSessionGUID(user_guid, shared_key, resend_code, inputedPassword, twoFACode, success, needs_two_factor_code, wrong_two_factor_code, authorization_received, other_error);
        });
      }

      if (obj.initial_error) {
        WalletStore.sendEvent("msg", {type: "error", message: obj.initial_error});
      }
    }
  });
};

MyWallet.pollForSessionGUID = function(user_guid, shared_key, resend_code, inputedPassword, twoFACode, success, needs_two_factor_code, wrong_two_factor_code, authorization_received, other_error) {
  if (WalletStore.isPolling()) return;

  WalletStore.setIsPolling(true);

  $.ajax({
    dataType: 'json',
    // contentType: "application/json; charset=utf-8",
    data: {format : 'plain'},
    xhrFields: {
      withCredentials: true
    },
    crossDomain: true,
    type: "GET",
    url: BlockchainAPI.getRootURL() + 'wallet/poll-for-session-guid',
    success: function (obj) {
      var self = this;
      if (obj.guid) {

        WalletStore.setIsPolling(false);

        authorization_received();

        WalletStore.sendEvent("msg", {type: "success", message: 'Authorization Successful'});

        MyWallet.fetchWalletJson(user_guid, shared_key, resend_code, inputedPassword, twoFACode, success, needs_two_factor_code, wrong_two_factor_code, null, other_error);
      } else {
        if (WalletStore.getCounter() < 600) {
          WalletStore.incrementCounter();
          setTimeout(function() {
            $.ajax(self);
          }, 2000);
        } else {
          WalletStore.setIsPolling(false);
        }
      }
    },
    error : function() {
      WalletStore.setIsPolling(false);
    }
  });
};

MyWallet.restoreWallet = function(pw, two_factor_auth_key, success, wrong_two_factor_code, other_error, decrypt_success, build_hd_success) {
  assert(success, 'Success callback required');
  assert(other_error, 'Error callback required');
  assert(decrypt_success, 'Decrypt success callback required');
  assert(build_hd_success, 'Build HD success callback required');

  if (isInitialized || WalletStore.isRestoringWallet()) {
    return;
  }

  function _error(e) {
    WalletStore.setRestoringWallet(false);
    WalletStore.sendEvent("msg", {type: "error", message: e});

    WalletStore.sendEvent('error_restoring_wallet');
    other_error(e);
  }
  
  WalletStore.setRestoringWallet(true);
  
  WalletStore.unsafeSetPassword(pw);

  //If we don't have any wallet data then we must have two factor authentication enabled
  var encryptedWalletData = WalletStore.getEncryptedWalletData();
  if (encryptedWalletData == null || encryptedWalletData.length == 0) {
    if (two_factor_auth_key == null) {
      other_error('Two Factor Authentication code this null');
      return;
    }

    if (two_factor_auth_key.length == 0 || two_factor_auth_key.length > 255) {
      other_error('You must enter a Two Factor Authentication code');
      return;
    }       

    $.ajax({
      timeout: 60000,
      type: "POST",
      // contentType: "application/json; charset=utf-8",
      xhrFields: {
        withCredentials: true
      },
      crossDomain: true,
      url: BlockchainAPI.getRootURL() + "wallet",
      data :  { guid: WalletStore.getGuid(), payload: two_factor_auth_key, length : two_factor_auth_key.length,  method : 'get-wallet', format : 'plain', api_code : WalletStore.getAPICode()},
      success: function(data) {
        if (data == null || data.length == 0) {
          other_error('Server Return Empty Wallet Data');
          return;
        }

        if (data != 'Not modified') {
          WalletStore.setEncryptedWalletData(data);
        }
        
        internalRestoreWallet(
          function() {
            WalletStore.setRestoringWallet(false);
            
            didDecryptWallet(success);
          }, 
          _error, 
          decrypt_success, 
          build_hd_success
        );
      },
      error : function (response) {
        _error(response.responseText);
        wrong_two_factor_code();
      }
    });
  } else {
    internalRestoreWallet(function() {
      WalletStore.setRestoringWallet(false);

      didDecryptWallet(success);
    }, _error, decrypt_success, build_hd_success);
  }
};

MyWallet.getIsInitialized = function() {
  return isInitialized;
};

function setIsInitialized() {
  if (isInitialized) return;

  webSocketConnect(wsSuccess);

  isInitialized = true;
}

MyWallet.connectWebSocket = function() {
  webSocketConnect(wsSuccess);
};

function emailBackup() {
  MyWallet.securePost("wallet", { method : 'email-backup' }, function(data) {
    WalletStore.sendEvent("msg", {type: "success", message: 'backup-success' + data});
  }, function(e) {
    WalletStore.sendEvent("msg", {type: "error", message: e.responseText});
  });
}

//Can call multiple times in a row and it will backup only once after a certain delay of activity
MyWallet.backupWalletDelayed = function(method, success, error, extra) {
  var sharedKey = WalletStore.getSharedKey();
  if (!sharedKey || sharedKey.length == 0 || sharedKey.length != 36) {
    throw 'Cannot backup wallet now. Shared key is not set';
  }

  WalletStore.disableLogout();
  WalletStore.setIsSynchronizedWithServer(false);
  WalletStore.clearArchTimer();

  var at = setTimeout(
    function (){
      MyWallet.backupWallet(method, success, error, extra);
    }
    , 3000);
  WalletStore.setArchTimer(at);
};

//Save the javascript wallet to the remote server
MyWallet.backupWallet = function(method, successcallback, errorcallback) {
  var sharedKey = WalletStore.getSharedKey();
  if (!sharedKey || sharedKey.length == 0 || sharedKey.length != 36) {
    throw 'Cannot backup wallet now. Shared key is not set';
  }

  WalletStore.disableLogout();
  WalletStore.clearArchTimer();

  var _errorcallback = function(e) {
    WalletStore.sendEvent('on_backup_wallet_error');

    WalletStore.sendEvent("msg", {type: "error", message: 'Error Saving Wallet: ' + e});

    // Re-fetch the wallet from server
    MyWallet.getWallet();

    errorcallback && errorcallback(e);
  };

  try {
    if (method == null) {
      method = 'update';
    }

    var data = MyWallet.makeWalletJSON();
    WalletStore.setLocalWalletJson(data); // I think this is not necessary

    //Everything looks ok, Encrypt the JSON output
    var crypted = WalletCrypto.encryptWallet( data
                                              , WalletStore.getPassword()
                                              , WalletStore.getPbkdf2Iterations()
                                              , WalletStore.didUpgradeToHd() ?  3.0 : 2.0 );

    if (crypted.length == 0) {
      throw 'Error encrypting the JSON output';
    }

    //Now Decrypt the it again to double check for any possible corruption
    WalletCrypto.decryptWallet(crypted, WalletStore.getPassword(), function(obj) {
      try {
        var old_checksum = WalletStore.getPayloadChecksum();
        WalletStore.sendEvent('on_backup_wallet_start');

        WalletStore.setEncryptedWalletData(crypted);

        var new_checksum = WalletStore.getPayloadChecksum();

        var data =  {
          length: crypted.length,
          payload: crypted,
          checksum: new_checksum,
          old_checksum : old_checksum,
          method : method,
          format : 'plain',
          language : WalletStore.getLanguage()
        };

        if (WalletStore.isSyncPubKeys()) {
          data.active = WalletStore.getLegacyActiveAddresses().join('|');
        }

        MyWallet.securePost("wallet", data, function(data) {
          checkWalletChecksum(new_checksum,
                              function() {
                                WalletStore.tagLegacyAddressesAsSaved();

                                if (successcallback != null)
                                  successcallback();

                                WalletStore.setIsSynchronizedWithServer(true);
                                WalletStore.enableLogout();
                                var log_time_out = setTimeout(MyWallet.logout, WalletStore.getLogoutTime());
                                WalletStore.setLogoutTimeout(log_time_out);
                                WalletStore.sendEvent('on_backup_wallet_success');
                              },
                              function() {
                                _errorcallback('Checksum Did Not Match Expected Value');
                                WalletStore.enableLogout();
                              });
        }, function(e) {
          _errorcallback(e.responseText);
          WalletStore.enableLogout();
        });
      } catch (e) {
        _errorcallback(e);
        WalletStore.enableLogout();
      };
    },
                               function(e) {
                                 console.log(e);
                                 throw("Decryption failed");
                               });
  } catch (e) {
    _errorcallback(e);
    WalletStore.enableLogout();
  }
};

MyWallet.handleNTPResponse = function(obj, clientTime) {
  //Calculate serverTimeOffset using NTP alog
  var nowTime = (new Date()).getTime();
  if (obj.clientTimeDiff && obj.serverTime) {
    var serverClientResponseDiffTime = nowTime - obj.serverTime;
    var responseTime = (obj.clientTimeDiff - nowTime + clientTime - serverClientResponseDiffTime) / 2;

    var thisOffset = (serverClientResponseDiffTime - responseTime) / 2;

    if (WalletStore.isHaveSetServerTime()) {
      var sto = (WalletStore.getServerTimeOffset() + thisOffset) / 2;
      WalletStore.setServerTimeOffset(sto);
    } else {
      WalletStore.setServerTimeOffset(thisOffset);
      WalletStore.setHaveSetServerTime();
      MyStore.put('server_time_offset', ''+WalletStore.getServerTimeOffset());
    }

    console.log('Server Time offset ' + WalletStore.getServerTimeOffset() + 'ms - This offset ' + thisOffset);
  }
};

/**
 * @param {string} address bitcoin address
 * @param {string} message message
 * @return {string} message signature in base64
 */
MyWallet.signmessage = function(address, message) {
  var addr = WalletStore.getAddress(address);

  if (!addr.priv)
    throw 'Cannot sign a watch only address';

  var decryptedpk = MyWallet.decodePK(addr.priv);

  var key = new ECKey(new BigInteger.fromBuffer(decryptedpk), false);
  if (key.pub.getAddress().toString() != address) {
    key = new ECKey(new BigInteger.fromBuffer(decryptedpk), true);
  }

  var signatureBuffer = Bitcoin.Message.sign(key, message, Bitcoin.networks.bitcoin);
  return signatureBuffer.toString("base64", 0, signatureBuffer.length);
};

/**
 * @param {string} input second password
 * @return {boolean} whether input matches set second password
 */
MyWallet.isCorrectSecondPassword = function(input) {
  if (! WalletStore.getDoubleEncryption()) {
    throw 'No second password set';
  }

  var thash = CryptoJS.SHA256(WalletStore.getSharedKey() + input);

  var password_hash = hashPassword(thash, WalletStore.getPbkdf2Iterations()-1);  //-1 because we have hashed once in the previous line

  if (password_hash == WalletStore.getDPasswordHash()) {
    return true;
  }

  return false;
};

/**
 * @param {string} input second password
 * @return {boolean} whether input matches second password
 */
MyWallet.validateSecondPassword = function(input) {
  var thash = CryptoJS.SHA256(WalletStore.getSharedKey() + input);

  var password_hash = hashPassword(thash, WalletStore.getPbkdf2Iterations()-1);  //-1 because we have hashed once in the previous line

  if (password_hash == WalletStore.getDPasswordHash()) {
    return true;
  }

  //Try 10 rounds
  if (WalletStore.getPbkdf2Iterations() != 10) {
    var iter_10_hash = hashPassword(thash, 10-1);  //-1 because we have hashed once in the previous line

    if (iter_10_hash == WalletStore.getDPasswordHash()) {
      // dpassword = input;
      WalletStore.setDPasswordHash(password_hash);
      return true;
    }
  }

  /*
   //disable old crypto stuff
   //Otherwise try SHA256 + salt
   if (Crypto.util.bytesToHex(thash) == dpasswordhash) {
   dpasswordhash = password_hash;
   return true;
   }

   //Legacy as I made a bit of a mistake creating a SHA256 hash without the salt included
   var leghash = Crypto.SHA256(input);

   if (leghash == dpasswordhash) {
   dpasswordhash = password_hash;
   return true;
   }
   //*/

  return false;
};

MyWallet.runCompressedCheck = function() {
  var to_check = [];
  var key_map = {};

  // TODO: this probably can be abstracted too in WalletStore
  var addresses = WalletStore.getAddresses();
  for (var key in addresses) {
    var addr = addresses[key];

    if (addr.priv != null) {
      var decryptedpk = MyWallet.decodePK(addr.priv);

      var privatekey = new ECKey(new BigInteger.fromBuffer(decryptedpk), false);

      var uncompressed_address = MyWallet.getUnCompressedAddressString(privatekey);
      var compressed_address = MyWallet.getCompressedAddressString(privatekey);

      var isCompressed = false;
      if (addr.addr != uncompressed_address) {
        key_map[uncompressed_address] = addr.priv;
        to_check.push(uncompressed_address);
      }

      if (addr.addr != compressed_address) {
        key_map[compressed_address] = addr.priv;
        to_check.push(compressed_address);
        isCompressed = true;
      }
    }
  }

  if (to_check.length == 0) {
    alert('to_check length == 0');
  }

  BlockchainAPI.get_balances(to_check, function(results) {
    var total_balance = 0;
    for (var key in results) {
      var balance = results[key].final_balance;
      if (balance > 0) {
        var ecKey = new ECKey(new BigInteger.fromBuffer(MyWallet.decodePK(key_map[key])), isCompressed);

        var address = ecKey.getBitcoinAddress().toString();

        if (MyWallet.addPrivateKey(ecKey, {compressed : address != key, app_name : IMPORTED_APP_NAME, app_version : IMPORTED_APP_VERSION})) {
          alert(formatBTC(balance) + ' claimable in address ' + key);
        }
      }
      total_balance += balance;
    }

    alert(formatBTC(total_balance) + ' found in compressed addresses');

    if (total_balance > 0) {
      MyWallet.backupWallet('update', function() {
        MyWallet.get_history();
      });
    }
  });
};

/**
 * Check the integrity of all keys in the wallet
 * @param {string?} second_password Second password to decrypt private keys if set
 */
MyWallet.checkAllKeys = function(second_password) {

  var sharedKey = WalletStore.getSharedKey();
  var pbkdf2_iterations = WalletStore.getPbkdf2Iterations();

  // TODO: this probably can be abstracted too in WalletStore
  var addresses = WalletStore.getAddresses();

  for (var key in addresses) {
    var addr = addresses[key];

    if (addr.addr == null) {
      console.log('Null Address Found in wallet ' + key);
      throw 'Null Address Found in wallet ' + key;
    }

    //Will throw an exception if the checksum does not validate
    if (addr.addr.toString() == null) {
      console.log('Error decoding wallet address ' + addr.addr);
      throw 'Error decoding wallet address ' + addr.addr;
    }

    if (addr.priv != null) {
      var decryptedpk;

      if(addr.priv == null || second_password == null) {
        decryptedpk = addr.priv;
      } else {
        decryptedpk = WalletCrypto.decryptSecretWithSecondPassword(addr.priv, second_password, sharedKey, pbkdf2_iterations);
      }

      var decodedpk = MyWallet.B58LegacyDecode(decryptedpk);

      var privatekey = new ECKey(new BigInteger.fromBuffer(decodedpk), false);

      var actual_addr = MyWallet.getUnCompressedAddressString(privatekey);
      if (actual_addr != addr.addr && MyWallet.getCompressedAddressString(privatekey) != addr.addr) {
        console.log('Private key does not match bitcoin address ' + addr.addr + " != " + actual_addr);
        throw 'Private key does not match bitcoin address ' + addr.addr + " != " + actual_addr;
      }

      if (second_password != null) {
        addr.priv = WalletCrypto.encryptSecretWithSecondPassword(decryptedpk, second_password, sharedKey, pbkdf2_iterations);
      }
    }
  }

  for (var i in MyWallet.getAccounts()) {
    var account = WalletStore.getHDWallet().getAccount(i);

    var decryptedpk;
    if(account.extendedPrivateKey == null || second_password == null) {
      decryptedpk = account.extendedPrivateKey;
    } else {
      decryptedpk = WalletCrypto.decryptSecretWithSecondPassword(account.extendedPrivateKey, second_password, sharedKey, pbkdf2_iterations);
    }

    try {
      var hdWalletAccount = new HDAccount();
      hdWalletAccount.newNodeFromExtKey(decryptedpk);
    } catch (e) {
      console.log('Invalid extended private key');
      throw 'Invalid extended private key';
    }
  }

  WalletStore.sendEvent("msg", {type: "success", message: 'wallet-success ' + 'Wallet verified.'});
};

/**
 * @param {string} inputedEmail user email
 * @param {string} inputedPassword user main password
 * @param {string} languageCode fiat currency code (e.g. USD)
 * @param {string} currencyCode language code (e.g. en)
 * @param {function(string, string, string)} success callback function with guid, sharedkey and password
 * @param {function(string)} error callback function with error message
 */
MyWallet.createNewWallet = function(inputedEmail, inputedPassword, languageCode, currencyCode, success, error) {
  WalletSignup.generateNewWallet(inputedPassword, inputedEmail, function(createdGuid, createdSharedKey, createdPassword) {
    MyStore.clear();
    if (languageCode)
      WalletStore.setLanguage(languageCode);

    WalletStore.setSharedKey(createdSharedKey);

    success(createdGuid, createdSharedKey, createdPassword);
  }, function (e) {
    error(e);
  });
};

function nKeys(obj) {
  var size = 0, key;
  for (key in obj) {
    size++;
  }
  return size;
};

MyWallet.logout = function(force) {
  if (!force && WalletStore.isLogoutDisabled())
    return;

  WalletStore.sendEvent('logging_out');

  if (WalletStore.isDemoWallet()) {
    window.location = BlockchainAPI.getRootURL() + 'wallet/logout';
  } else {
    $.ajax({
      type: "GET",
      timeout: 60000,
      url: BlockchainAPI.getRootURL() + 'wallet/logout',
      data : {format : 'plain', api_code : WalletStore.getAPICode()},
      success: function(data) {
        window.location.reload();
      },
      error : function() {
        window.location.reload();
      }
    });
  }
};

function parseMiniKey(miniKey) {
  var check = Bitcoin.crypto.sha256(miniKey + "?");

  if (check[0] !== 0x00) {
    throw 'Invalid mini key';
  }

  return Bitcoin.crypto.sha256(miniKey);
}

MyWallet.detectPrivateKeyFormat = function(key) {
  // 51 characters base58, always starts with a '5'
  if (/^5[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{50}$/.test(key))
    return 'sipa';

  //52 character compressed starts with L or K
  if (/^[LK][123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{51}$/.test(key))
    return 'compsipa';

  // 52 characters base58
  if (/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{44}$/.test(key) || /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{43}$/.test(key))
    return 'base58';

  if (/^[A-Fa-f0-9]{64}$/.test(key))
    return 'hex';

  if (/^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=+\/]{44}$/.test(key))
    return 'base64';

  if (/^6P[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{56}$/.test(key))
    return 'bip38';

  if (/^S[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{21}$/.test(key) ||
      /^S[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25}$/.test(key) ||
      /^S[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{29}$/.test(key) ||
      /^S[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{30}$/.test(key)) {

    var testBytes = Bitcoin.crypto.sha256(key + "?");

    if (testBytes[0] === 0x00 || testBytes[0] === 0x01)
      return 'mini';
  }

  return null;

  console.error('Unknown Key Format ' + key);
};

function buffertoByteArray(value) {
  return BigInteger.fromBuffer(value).toByteArray();
}

MyWallet.privateKeyStringToKey = function(value, format) {
  var key_bytes = null;

  if (format == 'base58') {
    key_bytes = buffertoByteArray(Base58.decode(value));
  } else if (format == 'base64') {
    key_bytes = buffertoByteArray(new Buffer(value, 'base64'));
  } else if (format == 'hex') {
    key_bytes = buffertoByteArray(new Buffer(value, 'hex'));
  } else if (format == 'mini') {
    key_bytes = buffertoByteArray(parseMiniKey(value));
  } else if (format == 'sipa') {
    var tbytes = buffertoByteArray(Base58.decode(value));
    tbytes.shift(); //extra shift cuz BigInteger.fromBuffer prefixed extra 0 byte to array
    tbytes.shift();
    key_bytes = tbytes.slice(0, tbytes.length - 4);

  } else if (format == 'compsipa') {
    var tbytes = buffertoByteArray(Base58.decode(value));
    tbytes.shift(); //extra shift cuz BigInteger.fromBuffer prefixed extra 0 byte to array
    tbytes.shift();
    tbytes.pop();
    key_bytes = tbytes.slice(0, tbytes.length - 4);
  } else {
    throw 'Unsupported Key Format';
  }

  if (key_bytes.length != 32 && key_bytes.length != 33)
    throw 'Result not 32 or 33 bytes in length';

  return new ECKey(new BigInteger.fromByteArrayUnsigned(key_bytes), (format == 'compsipa'));
};
