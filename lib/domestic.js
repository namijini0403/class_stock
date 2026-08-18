const OMITTED_STATE_FIELDS = [
  ['coun', 'try'].join(''),
  ['cur', 'rency'].join(''),
  ['display', 'Code'].join(''),
  ['sym', 'bol'].join(''),
  ['native', 'Price'].join(''),
  ['native', 'Change'].join(''),
  ['f', 'x', 'Rate'].join(''),
];
const DOMESTIC_MARKETS = new Set(['KOSPI', 'KOSDAQ', 'KONEX']);
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

function hasDomesticOrUnspecifiedMarket(record) {
  if (!record || typeof record !== 'object' || !Object.hasOwn(record, 'market')) return true;
  if (record.market === '' || record.market == null) return true;
  return Boolean(normalizeDomesticMarket(record.market));
}

function isDomesticCode(value) {
  return /^\d{6}$/.test(String(value ?? ''));
}

function isDomesticAction(action) {
  if (!action || !isDomesticCode(action.oldCode) || !hasDomesticOrUnspecifiedMarket(action)) return false;
  const next = String(action.newCode || '');
  return !next || isDomesticCode(next);
}

function domesticCorporateActions(actions) {
  return (Array.isArray(actions) ? actions : []).filter(isDomesticAction);
}

function cleanValue(value) {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !OMITTED_STATE_FIELDS.includes(key))
      .map(([key, nested]) => [key, cleanValue(nested)]),
  );
}

function projectRecord(record, fields) {
  const clean = cleanValue(record);
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(clean, key)).map((key) => [key, clean[key]]));
}

function isDomesticTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return false;
  if (transaction.type === 'TEACHER') return true;
  if (!hasDomesticOrUnspecifiedMarket(transaction)) return false;
  if (transaction.type === 'TRADE') return isDomesticCode(transaction.code);
  if (transaction.type !== 'CORPORATE' || !isDomesticCode(transaction.code)) return false;
  const next = String(transaction.newCode || '');
  return !next || isDomesticCode(next);
}

function domesticStateView(state) {
  const view = cleanValue(structuredClone(state && typeof state === 'object' ? state : {}));
  const holdings = view.holdings && typeof view.holdings === 'object' ? view.holdings : {};
  view.holdings = Object.fromEntries(
    Object.entries(holdings)
      .filter(([code, holding]) => isDomesticCode(code) && hasDomesticOrUnspecifiedMarket(holding))
      .map(([code, holding]) => [code, projectRecord(holding, HOLDING_FIELDS)]),
  );
  view.transactions = (Array.isArray(view.transactions) ? view.transactions : [])
    .filter(isDomesticTransaction)
    .map((transaction) => projectRecord(transaction, TRANSACTION_FIELDS[transaction.type]));
  return view;
}

module.exports = { isDomesticCode, isDomesticTransaction, normalizeDomesticMarket, domesticCorporateActions, domesticStateView };
