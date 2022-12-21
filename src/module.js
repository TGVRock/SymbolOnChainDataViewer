
// symbol-sdk と関連モジュールのインポート
const sym = require("symbol-sdk");
const { async } = require('rxjs');
const nodeBuffer = require("Buffer").Buffer;
const nodeCrypto = require('crypto');

const MAINNODE = "https://ik1-432-48199.vs.sakura.ne.jp:3001";  // MAINNET
const TESTNODE = "https://vmi831828.contaboserver.net:3001";    // TESTNET

const PROTOCOL_NAME = 'eternal-book-protocol';  // プロトコル名
const CHIPER_ALGORITHM = 'aes-256-cbc';         // 暗号化アルゴリズム

// ネットワークタイプ
const NetTypeEnum = {
  Main : 104,
  Test : 152,
};

// オンチェーンデータタイプ
const OnChainDataTypeEnum = {
  EBP       : 100,
  NFTDrive  : 200,
  COMSA     : 300,
};

// リポジトリ
let repo = null;
let txRepo = null;
let mosaicRepo = null;
let nsRepo = null;

// オンチェーンデータの取得
getOnChainData = (async function(mosaicIdStr, netType) {
  // リポジトリ設定
  if (!(setRepository(netType))) {
    return null;
  }

  // モザイク情報の取得
  const mosaicInfo = await getMosaicInfo(mosaicIdStr);
  if (null === mosaicInfo) {
    return null;
  }

  // オンチェーンデータの取得
  const onChainData = await getEBPOnChainData(mosaicInfo.mosaicId, mosaicInfo.owner);
  mosaicInfo.data = (null !== onChainData && 0 < onChainData.length) ? onChainData : null;
  return mosaicInfo;
});

// リポジトリ設定
function setRepository(netType) {
  // 既にリポジトリが設定済みの場合は設定不要
  if (null !== repo) {
    return true;
  }

  // ノードURIの取得
  let nodeUri = '';
  switch (Number(netType)) {
    // メインネット
    case NetTypeEnum.Main:
      nodeUri = MAINNODE;
      break;
  
    // テストネット
    case NetTypeEnum.Test:
      nodeUri = TESTNODE;
      break;
  
    default:
      return false;
  }

  // リポジトリ設定
  repo = new sym.RepositoryFactoryHttp(nodeUri);
  txRepo = repo.createTransactionRepository();
  mosaicRepo = repo.createMosaicRepository();
  nsRepo = repo.createNamespaceRepository();
  return true;
}

// モザイク情報を取得する
async function getMosaicInfo(mosaicIdStr) {
  // 入力チェック
  if (('' == mosaicIdStr)) {
    return null;
  }

  // モザイク情報の復元
  const mosaicId = new sym.MosaicId(mosaicIdStr);
  const mosaicInfo = await mosaicRepo.getMosaic(mosaicId).toPromise();
  // モザイク情報を抽出
  const readOnChainData = {};
  readOnChainData.mosaicId = mosaicInfo.id.toHex();
  readOnChainData.supply = mosaicInfo.supply.toString();
  readOnChainData.height = mosaicInfo.startHeight.toString();
  readOnChainData.owner = mosaicInfo.ownerAddress.address;
  readOnChainData.supplyMutable = mosaicInfo.flags.supplyMutable;
  readOnChainData.transferable = mosaicInfo.flags.transferable;
  readOnChainData.restrictable = mosaicInfo.flags.restrictable;
  readOnChainData.revokable = mosaicInfo.flags.revokable;

  // モザイクにリンクされているネームスペースを取得
  readOnChainData.alias = null;
  const mosaicsName = await nsRepo.getMosaicsNames([mosaicId]).toPromise();
  if (0 < mosaicsName.length) {
    const names = mosaicsName.find(name => (name.mosaicId.toString() === mosaicId.toString()));
    if (0 < names.names.length) {
      readOnChainData.alias = names.names[0].name;
    }
  }
  return readOnChainData;
}

// オリジナルフォーマット（eternal-book-protocol）で保存したデータを取得する
async function getEBPOnChainData(mosaicIdStr, ownerAddress) {
  const address = sym.Address.createFromRawAddress(ownerAddress);
  try {
    // アカウントのアグリゲートトランザクションを全て取得
    let allAggTxes = [];
    let isLastPage = false;
    while (!isLastPage) {
      const aggTxes = await txRepo.search({
        type:[
          sym.TransactionType.AGGREGATE_COMPLETE,
          sym.TransactionType.AGGREGATE_BONDED,
        ],
        address: address,
        group: sym.TransactionGroup.Confirmed,
        pageSize: 100
      }).toPromise();
      allAggTxes = allAggTxes.concat(aggTxes.data);
      isLastPage = aggTxes.isLastPage;
    }

    // オンチェーンデータアグリゲートの取得
    const onChainDataAggTxes = [];
    for (let idx = 0; idx < allAggTxes.length; idx++) {
      const aggTx = await txRepo.getTransaction(
        allAggTxes[idx].transactionInfo.hash,
        sym.TransactionGroup.Confirmed
      ).toPromise();

      // アグリゲート内トランザクションの検証
      const txes = aggTx.innerTransactions.filter(tx => (
        (tx.type === sym.TransactionType.TRANSFER)
        && (tx.signer.address.address === tx.recipientAddress.address)
      ));
      if (0 === aggTx.innerTransactions.length) {
        // アグリゲート内にトランザクションが存在しない場合は無効データ
        continue;
      }
      if (aggTx.innerTransactions.length !== txes.length) {
        // アグリゲート内の全てのトランザクションが自分から自分への転送トランザクションではない場合は無効データ
        continue;
      }

      // ヘッダ復号
      const dataHeader = decryptoHeader(mosaicIdStr, aggTx.innerTransactions[0].message.payload);
      if (null === dataHeader) {
        continue;
      }
      // ヘッダ検証
      if (PROTOCOL_NAME !== dataHeader.version.substr(0, PROTOCOL_NAME.length)){
        // プロトコル不一致
        continue;
      }
      if ((mosaicIdStr !== dataHeader.mosaicId) || (ownerAddress !== dataHeader.address)){
        // モザイク情報不一致
        continue;
      }

      // オンチェーンデータアグリゲートとして記録
      onChainDataAggTxes.push({
        header: dataHeader,
        aggregateTx: aggTx,
      });
    }
    // オンチェーンデータアグリゲートが存在しない場合は終了
    if (0 === onChainDataAggTxes.length) {
      return null;
    }

    // オンチェーンデータの最終データを集める
    const lastDatas = onChainDataAggTxes.filter(aggTx => ('hash' in aggTx.header));
    // ブロック高順にソート
    const sortedLastDatas = lastDatas.sort(function(a, b) {
      if (Number(a.aggregateTx.transactionInfo.height) > Number(b.aggregateTx.transactionInfo.height)) {return 1;} else {return -1;}
    });
    console.log(sortedLastDatas);

    // オンチェーンデータの復元
    const onChainDatas = [];
    for(let idxLastData = 0; idxLastData < sortedLastDatas.length; idxLastData++){
      // 検証のためのハッシュを取得
      const verifyHash = sortedLastDatas[idxLastData].header.hash;
      const timestamp = sortedLastDatas[idxLastData].aggregateTx.transactionInfo.timestamp.toString();
      console.log(timestamp);

      // 末尾のデータから遡ってオンチェーンデータを復元
      let onChainData = '';
      let nowAggTx = sortedLastDatas[idxLastData];
      while (true) {
        // 1つのアグリゲートに記録されているデータを抽出
        let innerData = '';
        for(let idx = 1; idx < nowAggTx.aggregateTx.innerTransactions.length; idx++){
          innerData += nowAggTx.aggregateTx.innerTransactions[idx].message.payload;
        }
        onChainData = innerData + onChainData;

        // 先頭データの場合は終了
        if (null === nowAggTx.header.prevTx) {
          break;
        }

        // 1つ前のアグリゲートトランザクションを検索
        const prevAggTx = onChainDataAggTxes.filter(aggTx => (nowAggTx.header.prevTx === aggTx.aggregateTx.transactionInfo.hash));
        if (0 === prevAggTx.length) {
          // 存在しない場合は復元終了
          break;
        } else if (1 < prevAggTx.length) {
          // ありえないはずのため、ログ出力のみ
          console.log('transaction duplicated!');
        }
        nowAggTx = prevAggTx[0];
      }

      // 復元したデータのハッシュとトランザクションに保持しているハッシュを検証
      const hashsum = nodeCrypto.createHash('sha512');
      const hash = hashsum.update(onChainData).digest('hex');
      if(hash === verifyHash) {
        // ハッシュが一致する場合のみ正しいオンチェーンデータとして扱う
        onChainDatas.push({
          title: nowAggTx.header.title,
          description: nowAggTx.header.description,
          data: onChainData,
        });
      } else {
        console.log(onChainData.length);
        console.log(hash);
        console.log(verifyHash);
      }
    }
    return onChainDatas;
  } catch (error) {
    // エラー発生時はエラー情報を出力
    console.log(error);
  }
  return null;
}

// ヘッダの復元
function decryptoHeader(mosaicIdStr, encryptoDataStr) {
  try {
    const encryptedData = nodeBuffer.from(encryptoDataStr, 'hex');
    const decipher = nodeCrypto.createDecipheriv(
      CHIPER_ALGORITHM,
      'EternalBookProtocol-OnChainData.',
      mosaicIdStr
    );
    const decipherData = decipher.update(encryptedData);
    const decryptedData = nodeBuffer.concat([decipherData, decipher.final()]);
    return JSON.parse(decryptedData.toString());
  } catch (error) {
    // 仕様に合わない暗号化データ、またはJSONのため無効データと判定する
  }
  return null;
}