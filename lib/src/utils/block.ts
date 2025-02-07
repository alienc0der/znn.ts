import { logger } from "ethers";
import { GetRequiredParam } from "../model/embedded/plasma";
import { AccountBlockTemplate, BlockTypeEnum } from "../model/nom/account_block_template";
import { emptyHash, Hash } from "../model/primitives/hash";
import { HashHeight } from "../model/primitives/hash_height";
import { KeyPair } from "../wallet/keypair";
import { Zenon } from "../zenon";
import { PowStatus, generatePoW } from "./../pow/pow";
import { BytesUtils } from "./bytes";

export class BlockUtils {
  static isSendBlock(blockType?: number): boolean{
    return [BlockTypeEnum.userSend, BlockTypeEnum.contractSend].includes(blockType!);
  }

  static isReceiveBlock(blockType: number): boolean{
    return [BlockTypeEnum.userReceive, BlockTypeEnum.genesisReceive, BlockTypeEnum.contractReceive].includes(blockType!);
  }

  static async getTransactionHash(transaction: AccountBlockTemplate): Promise<Hash> {

    const versionBytes = BytesUtils.longToBytes(transaction.version);
    const chainIdentifierBytes =
        BytesUtils.longToBytes(transaction.chainIdentifier);
    const blockTypeBytes = BytesUtils.longToBytes(transaction.blockType);
    const previousHashBytes = transaction.previousHash.getBytes()!;
    const heightBytes = BytesUtils.longToBytes(transaction.height);
    const momentumAcknowledgedBytes = transaction.momentumAcknowledged.getBytes();
    const addressBytes = transaction.address.getBytes();
    const toAddressBytes = transaction.toAddress.getBytes();
    // ToDo important: If amount is negative, the returned result is different from the DART SDK
    // It results (TS) 
    // 255, 255, ... , 255, 232
    // Instead of (dart)
    // 0, 0, 0, 232
    const amountBytes =
        BytesUtils.numberToBytes(transaction.amount, 32);
    const tokenStandardBytes = transaction.tokenStandard.getBytes();
    const fromBlockHashBytes = transaction.fromBlockHash.hash;
    const descendentBlocksBytes = (await Hash.digest(Buffer.from([]))).getBytes();
    const dataBytes = (await Hash.digest(transaction.data)).getBytes();
    const fusedPlasmaBytes = BytesUtils.longToBytes(transaction.fusedPlasma);
    const difficultyBytes = BytesUtils.longToBytes(transaction.difficulty);
    const nonceBytes = BytesUtils.leftPadBytes(Buffer.from(transaction.nonce, "hex"), 8);  

    const source = Buffer.concat([
      versionBytes,
      chainIdentifierBytes,
      blockTypeBytes,
      previousHashBytes,
      heightBytes,
      momentumAcknowledgedBytes,
      addressBytes,
      toAddressBytes,
      amountBytes,
      tokenStandardBytes,
      fromBlockHashBytes,
      descendentBlocksBytes,
      dataBytes,
      fusedPlasmaBytes,
      difficultyBytes,
      nonceBytes
    ])

    return Hash.digest(source);
  }

  static async _getTransactionSignature(keyPair: KeyPair, transaction: AccountBlockTemplate): Promise<Buffer>{
    const sig = await keyPair.sign(transaction.hash.getBytes()!);
    return sig
  }

  static async _getPoWData(transaction: AccountBlockTemplate): Promise<Hash> {
    return await Hash.digest(Buffer.concat(
        [transaction.address.getBytes(), transaction.previousHash.getBytes()]));
  }

  static async _autofillTransactionParameters(zenonInstance: Zenon, accountBlockTemplate: AccountBlockTemplate): Promise<void> {
    let frontierAccountBlock = await zenonInstance.ledger.getFrontierBlock(accountBlockTemplate.address);
    let height = 1;
    let previousHash: Hash = emptyHash;

    if (frontierAccountBlock != null) {
      height = frontierAccountBlock.height + 1;
      previousHash = frontierAccountBlock.hash;
    }

    accountBlockTemplate.height = height;
    accountBlockTemplate.previousHash = previousHash;

    let frontierMomentum = await zenonInstance.ledger.getFrontierMomentum();
    let momentumAcknowledged =
        new HashHeight(frontierMomentum.hash, frontierMomentum.height);
    accountBlockTemplate.momentumAcknowledged = momentumAcknowledged;

  }
  
  static async _checkAndSetFields(zenonInstance: Zenon, transaction: AccountBlockTemplate, currentKeyPair: KeyPair){
    // const zenonInstance = Zenon.getSingleton();

    transaction.address = (await currentKeyPair.getAddress())!;
    transaction.publicKey = (await currentKeyPair.getPublicKey());
    
    await BlockUtils._autofillTransactionParameters(zenonInstance, transaction);

    if (BlockUtils.isSendBlock(transaction.blockType)) {
    } else {
      if (transaction.fromBlockHash == emptyHash) {
        throw Error();
      }

      let sendBlock = await zenonInstance.ledger.getBlockByHash(transaction.fromBlockHash);
      if (sendBlock == null) {
        throw Error();
      }
      if (!(sendBlock.toAddress.toString() == transaction.address.toString())) {
        throw Error();
      }

      if (transaction.data.length > 0) {
        throw Error();
      }
    }

    if (transaction.difficulty > 0 && transaction.nonce == '') {
      throw Error();
    }
    return true;
  }

  static async _setDifficulty(zenonInstance: Zenon, transaction: AccountBlockTemplate, generatingPowCallback?: Function, waitForRequiredPlasma = false): Promise<boolean> {
    let powParam = new GetRequiredParam(transaction.address, transaction.blockType, transaction.toAddress, transaction.data);    
    let response = await zenonInstance.embedded.plasma.getRequiredPoWForAccountBlock(powParam);
    
    if (response.requiredDifficulty != 0) {
      transaction.fusedPlasma = response.availablePlasma;
      transaction.difficulty = response.requiredDifficulty;
      const powData = await BlockUtils._getPoWData(transaction);
      logger.info(`Generating Plasma for block: hash=${powData}`);
      generatingPowCallback?.call(PowStatus.generating);
      transaction.nonce = await generatePoW(powData, transaction.difficulty) + "";
      generatingPowCallback?.call(PowStatus.done);
    } else {
      transaction.fusedPlasma = response.basePlasma;
      transaction.difficulty = 0;
      transaction.nonce = '0000000000000000';
    }
    return true;
  }

  static async _setHashAndSignature(transaction: AccountBlockTemplate, currentKeyPair: KeyPair): Promise<boolean>{
    transaction.hash = await BlockUtils.getTransactionHash(transaction);
    let transSig = await BlockUtils._getTransactionSignature(currentKeyPair, transaction);
    transaction.signature = transSig;
    return true;
  }

  static async send(zenonInstance: Zenon,
    transaction: AccountBlockTemplate, 
    currentKeyPair: KeyPair, 
    generatingPowCallback?: Function,
    waitForRequiredPlasma = false
    ): Promise<AccountBlockTemplate>{

      await BlockUtils._checkAndSetFields(zenonInstance, transaction, currentKeyPair);
      await BlockUtils._setDifficulty(zenonInstance, transaction, generatingPowCallback, waitForRequiredPlasma);
      await BlockUtils._setHashAndSignature(transaction, currentKeyPair);
     
      await zenonInstance.ledger.publishRawTransaction(transaction);
      logger.info('Published account-block');
      return transaction;
    }
}


