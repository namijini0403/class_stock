const DOMESTIC_MARKETS = new Set(['KOSPI', 'KOSDAQ', 'KONEX']);
const STATE_FIELDS = [
  'schema', 'accountId', 'grade', 'classNo', 'studentNo', 'name',
  'cash', 'initialCash', 'teacherNetAdjustments', 'realizedPnl', 'totalFees',
  'corporateActionsApplied', 'version', 'createdAt', 'updatedAt',
];
const HOLDING_FIELDS = ['qty', 'avgPrice', 'name', 'status', 'valuationPrice'];
const TRANSACTION_FIELDS = {
  TEACHER: ['id', 'type', 'at', 'side', 'name', 'qty', 'price', 'amount', 'signedAmount', 'requestedAmount', 'reason', 'commandId', 'teacherName'],
  TRADE: ['id', 'type', 'at', 'side', 'code', 'name', 'market', 'qty', 'price', 'amount', 'grossAmount', 'fee', 'feeRate', 'netAmount', 'comment', 'commentUpdatedAt', 'quoteSource', 'quoteSourceLabel', 'quoteAsOfDate'],
  CORPORATE: ['id', 'type', 'at', 'side', 'code', 'newCode', 'name', 'newName', 'qty', 'price', 'amount', 'signedAmount', 'reason', 'detail', 'corporateActionId'],
};

function normalizeDomesticMarket(value) {
  const market = String(value ?? '').trim().toUpperCase();
  return DOMESTIC_MARKETS.has(market) ? market : '';
}

function isDomesticCode(value) {
  return /^\d{6}$/.test(String(value ?? ''));
}

function isDomesticAction(action) {
  if (!action || !isDomesticCode(action.oldCode)) return false;
  const next = String(action.newCode || '');
  return !next || isDomesticCode(next);
}

function domesticCorporateActions(actions) {
  return (Array.isArray(actions) ? actions : []).filter(isDomesticAction);
}

function projectRecord(record, fields) {
  const source = record && typeof record === 'object' ? record : {};
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(source, key)).map((key) => [key, structuredClone(source[key])]),
  );
}

function isDomesticTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return false;
  if (transaction.type === 'TEACHER') return true;
  if (transaction.type === 'TRADE') return isDomesticCode(transaction.code) && Boolean(normalizeDomesticMarket(transaction.market));
  if (transaction.type !== 'CORPORATE' || !isDomesticCode(transaction.code)) return false;
  const next = String(transaction.newCode || '');
  return !next || isDomesticCode(next);
}

function domesticStateView(state) {
  const source = state && typeof state === 'object' ? state : {};
  const view = projectRecord(source, STATE_FIELDS);
  const holdings = source.holdings && typeof source.holdings === 'object' ? source.holdings : {};
  view.holdings = Object.fromEntries(
    Object.entries(holdings)
      .filter(([code, holding]) => isDomesticCode(code) && (!Object.hasOwn(holding || {}, 'market') || Boolean(normalizeDomesticMarket(holding.market))))
      .map(([code, holding]) => [code, projectRecord(holding, HOLDING_FIELDS)]),
  );
  view.transactions = (Array.isArray(source.transactions) ? source.transactions : [])
    .filter(isDomesticTransaction)
    .map((transaction) => {
      const projected = projectRecord(transaction, TRANSACTION_FIELDS[transaction.type]);
      if (projected.type === 'TRADE') projected.market = normalizeDomesticMarket(projected.market);
      return projected;
    });
  return view;
}

module.exports = { isDomesticCode, isDomesticTransaction, normalizeDomesticMarket, domesticCorporateActions, domesticStateView };
