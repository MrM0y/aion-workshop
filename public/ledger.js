const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

/**
 * Actual recorded accounting. Historical tax amounts never change when current
 * tax rates change. All recorded listing fees are expenses already incurred.
 * Throws on malformed or oversold batches rather than returning a false balance.
 */
export function batchTotals(batch) {
  if (!batch || !positiveInteger(batch.quantity) || !nonnegative(batch.cost) || !Array.isArray(batch.sales) || !Array.isArray(batch.listingCosts)) {
    throw new Error('Некоректна кількість, собівартість або журнал партії.');
  }
  let sold = 0, gross = 0, tax = 0, listing = 0;
  for (const sale of batch.sales) {
    if (!sale || !positiveInteger(sale.quantity) || !nonnegative(sale.price) || !nonnegative(sale.tax)) throw new Error('Некоректний запис продажу.');
    const revenue = sale.quantity * sale.price;
    if (!nonnegative(revenue) || sale.tax > revenue) throw new Error('Податок продажу перевищує виручку або сума некоректна.');
    sold += sale.quantity; gross += revenue; tax += sale.tax;
  }
  if (!Number.isSafeInteger(sold) || sold > batch.quantity) throw new Error('Продано більше предметів, ніж створено в партії.');
  for (const entry of batch.listingCosts) {
    if (!entry || !nonnegative(entry.amount)) throw new Error('Некоректна комісія виставлення.');
    listing += entry.amount;
  }
  if (![gross, tax, listing].every(nonnegative)) throw new Error('Суми журналу перевищують межі розрахунку.');
  const allocated = batch.cost * (sold / batch.quantity);
  const totals = {sold, left: batch.quantity - sold, gross, tax, listing,
    net: gross - tax - listing - allocated,
    cash: gross - tax - listing - batch.cost,
    stockCost: batch.cost - allocated};
  if (!Object.values(totals).every(Number.isFinite)) throw new Error('Суми журналу перевищують межі розрахунку.');
  return totals;
}

/**
 * Forecast all remaining units at batch.target with current confirmed taxes and
 * one additional listing fee. Already recorded listing fees are not charged again.
 * breakEven is the remaining unit price needed to recover the whole batch's cash
 * outlay, not the allocated accounting cost of one remaining unit.
 */
export function salesProjection(batch, settings = {}) {
  const totals = batchTotals(batch);
  const ratesKnown = settings.taxConfirmed === true && nonnegative(settings.saleTax) && nonnegative(settings.listingTax) && settings.saleTax + settings.listingTax < 100;
  if (!ratesKnown) return {breakEven:null, targetProfit:null};
  if (!totals.left) return {breakEven:null, targetProfit:totals.cash};
  const factor = 1 - (settings.saleTax + settings.listingTax) / 100;
  const price = Math.max(0, -totals.cash / (totals.left * factor));
  const targetProfit = nonnegative(batch.target) ? totals.cash + totals.left * batch.target * factor : null;
  return {breakEven: Number.isFinite(price) ? price : null,
    targetProfit: Number.isFinite(targetProfit) ? targetProfit : null};
}
