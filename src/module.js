
// symbol-sdk と関連モジュールのインポート
sym = require("symbol-sdk");
const { async } = require('rxjs');

const MAINNODE = "https://ik1-432-48199.vs.sakura.ne.jp:3001";  // MAINNET
const TESTNODE = "https://vmi831828.contaboserver.net:3001";    // TESTNET

const PROTOCOL_NAME = 'eternal-book-protocol';

const NetTypeEnum = {
  Invalid : -1,
  Main : 104,
  Test : 152,
};

repo = null;
txRepo = null;
mosaicRepo = null;
nsRepo = null;

// オンチェーンデータの取得
getOnChainData = (async function(mosaicIdStr, netType) {
  setRepository(netType);
  return await nftOrigin1Viewer(mosaicIdStr);
});

// リポジトリ設定
function setRepository(netType) {
  // 既にリポジトリが設定済みの場合は設定不要
  if (null !== repo) {
    return;
  }

  // ノードURIの取得
  nodeUri = '';
  switch (Number(netType)) {
    case NetTypeEnum.Main:
      nodeUri = MAINNODE;
      break;
  
    case NetTypeEnum.Test:
      nodeUri = TESTNODE;
      break;
  
    default:
      return;
  }

  // リポジトリ設定
  repo = new sym.RepositoryFactoryHttp(nodeUri);
  txRepo = repo.createTransactionRepository();
  mosaicRepo = repo.createMosaicRepository();
  nsRepo = repo.createNamespaceRepository();
}

async function nftOrigin1Viewer(mosaicIdStr) {
  const mosaicData = {};
  let retHtml = '';
  try {
    // 入力チェック
    if (('' == mosaicIdStr)) {
      mosaicData.errorMessage = 'MosaicId is not defined.';
    }
    if ('' != retHtml) {
      return mosaicData;
    }

    // モザイク情報の復元
    const mosaicId = new sym.MosaicId(mosaicIdStr);
    const mosaicInfo = await mosaicRepo.getMosaic(mosaicId).toPromise();
    console.log(mosaicIdStr);
    console.log(mosaicInfo.id.toHex());
    // 出力するモザイク情報の表示
    mosaicData.mosaicId = mosaicInfo.id.toHex();
    mosaicData.supply = mosaicInfo.supply.toString();
    mosaicData.height = mosaicInfo.startHeight.toString();
    mosaicData.owner = mosaicInfo.ownerAddress.address;
    mosaicData.supplyMutable = mosaicInfo.flags.supplyMutable;
    mosaicData.transferable = mosaicInfo.flags.transferable;
    mosaicData.restrictable = mosaicInfo.flags.restrictable;
    mosaicData.revokable = mosaicInfo.flags.revokable;

    // モザイクにリンクされているネームスペースを取得
    mosaicData.alias = null;
    const mosaicsName = await nsRepo.getMosaicsNames([mosaicId]).toPromise();
    if (0 < mosaicsName.length) {
      const names = mosaicsName.find(name => (name.mosaicId.toString() === mosaicId.toString()));
      if (0 < names.names.length) {
        mosaicData.alias = names.names[0].name;
      }
    }

    // モザイク作成したアカウントのアグリゲートトランザクションを全て取得
    aggTxes = [];
    isLastData = false;
    while (!isLastData) {
      const tx = await txRepo.search({
        type:[
          sym.TransactionType.AGGREGATE_COMPLETE,
          sym.TransactionType.AGGREGATE_BONDED,
        ],
        address: mosaicInfo.ownerAddress,
        group: sym.TransactionGroup.Confirmed,
        pageSize: 100
      }).toPromise();
      aggTxes = aggTxes.concat(tx.data);
      isLastData = tx.isLastPage;
    }

    // オンチェーンデータ作成アグリゲートの取得
    const mosaicCreateAggTxes = [];
    for (let idx = 0; idx < aggTxes.length; idx++) {
      const aggTx = await txRepo.getTransaction(
        aggTxes[idx].transactionInfo.hash,
        sym.TransactionGroup.Confirmed
      ).toPromise();
      // console.log(aggTx);

      if (0 === aggTx.innerTransactions.length) {
        // console.log('innner zero.');
        continue;
      }

      // アグリゲート内の全てのトランザクションが転送トランザクションではない場合は無効データ
      const txes = aggTx.innerTransactions.filter(tx => (tx.type === sym.TransactionType.TRANSFER));
      if (aggTx.innerTransactions.length !== txes.length) {
        // console.log('invalid transfer.');
        continue;
      }

      // ヘッダ検証
      const headerJsonStr = aggTx.innerTransactions[0].message.payload;
      if (!('{' == headerJsonStr.substr(0, 1)) || !('}' == headerJsonStr.substr(headerJsonStr.length - 1, 1))){
        // console.log('not json.');
        continue;
      }
      headerJson = JSON.parse(headerJsonStr);
      // if (PROTOCOL_NAME !== headerJson.version.substr(0, PROTOCOL_NAME.length)){
      //   continue;
      // }
      if ((mosaicInfo.id.toHex() !== headerJson.mosaicId) || (mosaicInfo.ownerAddress.address !== headerJson.address)){
        // console.log('creater invalid.');
        continue;
      }
      // TODO: 自分から自分への転送判定
      mosaicCreateAggTxes.push(aggTx);
    }

    // TODO: 複数データの場合
    const sotedAggTxes = mosaicCreateAggTxes.sort(function(a, b) {
      headerA = JSON.parse(a.innerTransactions[0].message.payload);
      headerB = JSON.parse(b.innerTransactions[0].message.payload);
      if (Number(headerA.no) > Number(headerB.no)) {return 1;} else {return -1;}
    })
    console.log(sotedAggTxes);

    // TODO: ちゃんと考える
    // TODO: 複数対応
    onChainData = '';
    nowAggTx = sotedAggTxes[sotedAggTxes.length - 1];
    while (null !== nowAggTx) {
      innerData = '';
      header = JSON.parse(nowAggTx.innerTransactions[0].message.payload);
      for(idx = 1; idx < nowAggTx.innerTransactions.length;idx++){
        innerData += nowAggTx.innerTransactions[idx].message.payload;
      }
      onChainData = innerData + onChainData;
      if (null === header.prevTx) {
        break;
      }
      nowAggTx = sotedAggTxes.find(aggTx => (header.prevTx === aggTx.transactionInfo.hash));
      console.log(nowAggTx);
    }
    mosaicData.title = header.title;
    mosaicData.description = header.description;
    mosaicData.data = onChainData;
  } catch (error) {
    // エラー発生時はエラー情報を出力
    mosaicData.errorMessage = error;
    console.log(error);
  }
  return mosaicData;
}