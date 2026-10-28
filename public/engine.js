/** Zero is known; null, strings and non-finite numbers are unknown. */
export const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const rate = value => valid(value) && value <= 1;
const dated = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function mergeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row.id), old = map.get(id);
    if (!old) map.set(id, {...row, id});
    else {
      old.quantity = valid(old.quantity) && valid(row.quantity) ? old.quantity + row.quantity : null;
      if (!valid(old.price) || !valid(row.price) || old.price !== row.price) old.price = null;
      if (!dated(old.at) || !dated(row.at)) old.at = null;
      else if (Date.parse(row.at) < Date.parse(old.at)) old.at = row.at;
    }
  }
  return [...map.values()];
}

/** Source quantities are per attempt; source listing prices never use cheaper subcraft costs. */
export function normalizeDetail(detail) {
  const at = detail.latest?.captured_at ?? null;
  const steps = (detail.steps ?? []).map(step => ({
    stepNo: step.step_no, masteryLevel: step.mastery_level,
    step_no: step.step_no, mastery_level: step.mastery_level,
    successRate: step.success_rate, comboProbability: step.combo_probability,
    success_rate: step.success_rate, combo_probability: step.combo_probability,
    craftFee: null, seconds: null,
    materials: (step.materials ?? []).map(item => ({
      id: String(item.material_key), name: item.name,
      quantity: item.per_attempt, price: item.listing_price ?? null, at
    }))
  }));
  return {id: String(detail.target_key), name: detail.name, category: detail.category,
    skill: detail.skill, imported: true, specialTarget: true, yield: 1,
    price: detail.latest?.market_price ?? null, at, listings: detail.latest?.listings ?? null,
    model: detail.model, carried: detail.latest?.carried ?? null,
    craftFee: null, seconds: null, steps,
    rows: mergeRows(steps.flatMap(step => step.materials))};
}
export function materials(detail) { return normalizeDetail(detail).rows; }

/**
 * count = fixed FINAL-stage attempts. Earlier attempts supply expected consumed
 * inputs: attempts[i] = attempts[i+1] / (success[i] * combo[i]).
 * craftFee/seconds on recipe apply PER ATTEMPT to EVERY stage; a stage may override.
 * Custom rows, failureRefunds and byproducts are quantities per attempt. Refunds
 * are expected salvage credit, never a reduction of required upfront investment.
 */
export function calculate(recipe, overrides = {}, settings = {}, count = 10) {
  const issues = [], warnings = [], observations = [];
  const issue = text => { if (!issues.includes(text)) issues.push(text); };
  const warn = text => { if (!warnings.includes(text)) warnings.push(text); };
  const failures = settings.includeFailures !== false, special = settings.includeSpecial !== false;
  const byproducts = settings.includeByproducts !== false;
  const countKnown = Number.isSafeInteger(count) && count > 0 && count <= 100000;
  if (!countKnown) issue('Кількість спроб має бути цілим числом від 1 до 100000.');
  if (settings.taxConfirmed !== true) issue('Підтвердьте ставки податків для свого ринку.');
  const taxesKnown = valid(settings.saleTax) && valid(settings.listingTax) && settings.saleTax + settings.listingTax < 100;
  if (!taxesKnown) issue('Ставки податків невідомі або їх сума не менша за 100%.');
  if (!failures) warn('Невдачі не враховано: усі спроби вважаються успішними.');
  if (!special) warn('Особливі результати не враховано.');
  function priceOf(item) {
    const manual = Object.hasOwn(overrides, String(item.id));
    const entry = manual ? overrides[String(item.id)] : item;
    const price = valid(entry?.price) ? entry.price : null, at = entry?.at ?? null;
    if (price !== null) {
      if (dated(at)) observations.push(at);
      else warn('Час частини цін невідомий.');
    }
    return {price, at, manual, updatedAt: manual ? at : null};
  }
  const chain = Array.isArray(recipe.steps) && recipe.steps.length > 0;
  const explicitOutcomes = !chain && Array.isArray(recipe.outcomes) && recipe.outcomes.length > 0;
  const successfulProbability = explicitOutcomes ? recipe.outcomes.reduce((sum, item) => sum + item.probability, 0) : recipe.successRate;
  if (explicitOutcomes && (!rate(successfulProbability) || successfulProbability === 0 || recipe.outcomes.some(item => !rate(item.probability)))) issue('Ймовірності взаємовиключних результатів мають давати суму від 0 до 1.');
  if (explicitOutcomes && !special && recipe.outcomes.length > 1) issue('Для кількох явних результатів не можна вимкнути особливі результати без окремої моделі.');
  const steps = chain ? recipe.steps : [{successRate: successfulProbability,
    comboProbability: explicitOutcomes ? 1 : recipe.comboProbability ?? (recipe.specialTarget ? null : 1),
    materials: recipe.rows ?? [], craftFee: recipe.craftFee, seconds: recipe.seconds}];
  const probabilities = steps.map(step => {
    if (!rate(step.successRate)) issue('Невідомий або некоректний шанс успіху.');
    if (!rate(step.comboProbability)) issue('Невідомий або некоректний шанс особливого результату.');
    const q = (failures ? step.successRate : 1) * (special ? step.comboProbability : 1);
    if (q === 0) issue('Бажаний результат має нульовий шанс отримання.');
    return q;
  });
  let target = recipe;
  if (!special && recipe.specialTarget && !explicitOutcomes) {
    if (!recipe.regularResult) issue('Ціну звичайного результату не задано: ціну особливого предмета використати не можна.');
    else target = {...recipe.regularResult, at: recipe.regularResult.at ?? recipe.at};
  }
  if (!explicitOutcomes && (!valid(target.yield) || target.yield === 0)) issue('Невідомий або некоректний вихід предметів.');
  const sale = explicitOutcomes ? {price: null} : priceOf(target);
  if (!explicitOutcomes && sale.price === null) issue('Невідома ціна продажу готового предмета.');
  const attempts = steps.map(() => null);
  attempts[attempts.length - 1] = countKnown ? count : null;
  for (let i = attempts.length - 2; i >= 0; i--) {
    if (!rate(probabilities[i]) || probabilities[i] === 0 || !valid(attempts[i + 1])) issue('Попередній етап не може забезпечити потрібний результат.');
    else {
      const n = attempts[i + 1] / probabilities[i];
      if (!valid(n)) issue('Кількість спроб перевищує межі розрахунку.');
      else attempts[i] = n;
    }
  }
  const batchRows = [];
  let craftFee = 0, seconds = 0, timeKnown = true;
  steps.forEach((step, i) => {
    const n = attempts[i], fee = step.craftFee ?? recipe.craftFee, duration = step.seconds ?? recipe.seconds;
    if (!valid(fee) || !valid(n)) { issue('Вкажіть плату за крафт кожної спроби, включно з нульовою.'); craftFee = null; }
    else if (craftFee !== null) craftFee += fee * n;
    if (!valid(duration) || !valid(n)) timeKnown = false;
    else seconds += duration * n;
    if (!Array.isArray(step.materials) || !step.materials.length) issue('Рецепт не містить матеріалів.');
    for (const item of step.materials ?? []) batchRows.push({...item,
      quantity: valid(item.quantity) && valid(n) ? item.quantity * n : null});
  });
  if (!timeKnown) { seconds = null; warn('Час крафту невідомий.'); }
  const rows = mergeRows(batchRows).map(item => {
    const observation = priceOf(item);
    const product = observation.price !== null && valid(item.quantity) ? observation.price * item.quantity : null;
    const subtotal = valid(product) ? product : null;
    if (subtotal === null) issue('Невідома ціна або кількість потрібного матеріалу.');
    return {...item, ...observation, subtotal};
  });
  const materialCost = rows.every(row => row.subtotal !== null) ? rows.reduce((sum, row) => sum + row.subtotal, 0) : null;
  let refundValue = 0, byproductGross = 0;
  const byproductRows = [];
  if (recipe.imported) warn('Звичайні та побічні результати ланцюга не оцінено: джерело не надало окремих даних.');
  if (valid(recipe.carried) && recipe.carried > 0) warn('Частину цін джерело перенесло з попередніх спостережень; час знімка не підтверджує точну давність кожної ціни.');
  if (!chain && byproducts) {
    for (const item of failures && successfulProbability < 1 ? recipe.failureRefunds ?? [] : []) {
      const observation = priceOf(item);
      if (!valid(item.quantity) || observation.price === null) issue('Неповні дані повернення матеріалів.');
      else refundValue += count * (failures ? 1 - successfulProbability : 0) * item.quantity * observation.price;
    }
    if (refundValue > 0) warn('Повернення матеріалів — очікуване відшкодування, яке не зменшує початковий бюджет.');
    if (materialCost !== null && refundValue > materialCost) issue('Вартість повернення матеріалів перевищує витрати матеріалів.');
    for (const item of recipe.byproducts ?? []) {
      if (item.probability === 0) continue;
      const observation = priceOf(item);
      if (!valid(item.quantity) || !rate(item.probability) || observation.price === null) issue('Неповні дані побічного результату.');
      else {
        const quantity = count * item.quantity * item.probability, subtotal = quantity * observation.price;
        byproductGross += subtotal; byproductRows.push({...item, ...observation, quantity, subtotal});
      }
    }
  }
  if (!byproducts && ((recipe.byproducts?.length ?? 0) || (recipe.failureRefunds?.length ?? 0))) warn('Повернення матеріалів та побічні результати не враховано.');
  const q = probabilities.at(-1);
  const outcomeRows = [];
  if (explicitOutcomes) for (const item of recipe.outcomes) {
    if (item.probability === 0) continue;
    const observation = priceOf(item);
    const probability = failures ? item.probability : item.probability / successfulProbability;
    const quantity = countKnown && rate(probability) && valid(item.quantity) ? count * probability * item.quantity : null;
    const subtotal = quantity !== null && observation.price !== null ? quantity * observation.price : null;
    if (subtotal === null || item.quantity === 0) issue('Неповні або некоректні дані результатів крафту.');
    outcomeRows.push({...item, ...observation, quantity, subtotal});
  }
  const expectedOutput = explicitOutcomes ? outcomeRows.every(row => row.quantity !== null) ? outcomeRows.reduce((sum, row) => sum + row.quantity, 0) : null
    : countKnown && rate(q) && valid(target.yield) ? count * q * target.yield : null;
  const gross = explicitOutcomes ? outcomeRows.every(row => row.subtotal !== null) ? outcomeRows.reduce((sum, row) => sum + row.subtotal, byproductGross) : null
    : sale.price !== null && expectedOutput !== null ? sale.price * expectedOutput + byproductGross : null;
  const saleTax = taxesKnown && gross !== null ? gross * settings.saleTax / 100 : null;
  const listingFee = taxesKnown && gross !== null ? gross * settings.listingTax / 100 : null;
  const investment = materialCost !== null && craftFee !== null && listingFee !== null ? materialCost + craftFee + listingFee : null;
  const rawProfit = gross !== null && saleTax !== null && investment !== null ? gross - saleTax - investment + refundValue : null;
  const roundingTolerance = Number.EPSILON * 16 * Math.max(Math.abs(gross ?? 0), Math.abs(investment ?? 0), Math.abs(refundValue));
  const profit = rawProfit !== null && Number.isFinite(rawProfit) && Math.abs(rawProfit) <= roundingTolerance ? 0 : rawProfit;
  const roi = investment > 0 && profit !== null ? profit / investment * 100 : null;
  const netFactor = taxesKnown ? 1 - (settings.saleTax + settings.listingTax) / 100 : null;
  const breakEven = !explicitOutcomes && expectedOutput > 0 && materialCost !== null && craftFee !== null && netFactor > 0
    ? Math.max(0, ((materialCost + craftFee - refundValue) / netFactor - byproductGross) / expectedOutput) : null;
  const oldestAt = observations.length ? observations.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null;
  const freshness = settings.freshMinutes ?? settings.fresh ?? 60;
  const carriedUnverified = valid(recipe.carried) && recipe.carried > 0 && rows.some(row => !row.manual);
  const stale = carriedUnverified || !oldestAt || !valid(freshness) || warnings.includes('Час частини цін невідомий.') || Date.now() - Date.parse(oldestAt) > freshness * 60000;
  if (stale) warn('Ціни застарілі або час спостереження невідомий.');
  if (chain && steps.length > 1) warn('Витрати попередніх етапів — математичне очікування, а не гарантований бюджет.');
  for (const value of [materialCost, craftFee, gross, saleTax, listingFee, investment, refundValue]) {
    if (value !== null && !valid(value)) issue('Суми перевищують межі розрахунку.');
  }
  if (profit !== null && !Number.isFinite(profit)) issue('Прибуток перевищує межі розрахунку.');
  const eligible = issues.length === 0 && roi !== null;
  let risk = null;
  if (eligible && !chain && !explicitOutcomes && !recipe.failureRefunds?.length && !recipe.byproducts?.length) {
    const netPerSuccess = sale.price * target.yield * netFactor, fixedCost = materialCost + craftFee;
    const ratio = fixedCost / netPerSuccess, nearest = Math.round(ratio);
    // Decimal prices can put an integral break-even threshold a few ulps above
    // the integer. Do not turn that break-even outcome into a counted loss.
    const threshold = nearest > 0 && Math.abs(ratio - nearest) <= Number.EPSILON * 16 * Math.max(1, Math.abs(ratio)) ? nearest : ratio;
    const losingCount = netPerSuccess > 0 ? Math.ceil(threshold) - 1 : fixedCost > 0 ? count : -1;
    risk = binomialCdf(count, q, losingCount);
  }
  return {rows, byproductRows, outcomeRows, price: sale.price, materialCost, craftFee, refundValue,
    expectedOutput, attempts, gross, saleTax, listingFee, investment,
    profit: issues.length ? null : profit, roi: issues.length ? null : roi,
    breakEven: issues.length ? null : breakEven, seconds, issues, warnings,
    eligible, oldestAt, stale, risk};
}

/** Exact binomial sum normalized around the mode avoids large-batch underflow. */
function binomialCdf(n, p, k) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p === 0) return 1;
  if (p === 1) return 0;
  const mode = Math.floor((n + 1) * p);
  let total = 1, losing = mode <= k ? 1 : 0, weight = 1;
  for (let j = mode; j > 0; j--) {
    weight *= j / (n - j + 1) * (1 - p) / p;
    total += weight; if (j - 1 <= k) losing += weight;
  }
  weight = 1;
  for (let j = mode; j < n; j++) {
    weight *= (n - j) / (j + 1) * p / (1 - p);
    total += weight; if (j + 1 <= k) losing += weight;
  }
  return Math.min(1, Math.max(0, losing / total));
}
