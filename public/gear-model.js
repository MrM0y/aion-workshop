const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const chance = value => nonnegative(value) && value > 0 && value <= 1;
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Seeded, reproducible Monte Carlo: no browser state, network, or random globals. */
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let n = state;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

function logGamma(value) {
  const coefficients = [676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  const z = value - 1;
  let x = .99999999999980993;
  for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (z + i + 1);
  const t = z + 7.5;
  return .9189385332046727 + (z + .5) * Math.log(t) - t + Math.log(x);
}

function samplers(random) {
  const openRandom = () => Math.max(Number.MIN_VALUE, random());
  const normal = () => Math.sqrt(-2 * Math.log(openRandom())) * Math.cos(2 * Math.PI * random());
  function gamma(shape) {
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    while (true) {
      const x = normal(), v0 = 1 + c * x;
      if (v0 <= 0) continue;
      const v = v0 * v0 * v0, u = openRandom();
      if (u < 1 - .0331 * x ** 4 || Math.log(u) < .5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  function poisson(lambda) {
    if (lambda < 30) {
      const limit = Math.exp(-lambda);
      let product = 1, count = 0;
      do { count++; product *= openRandom(); } while (product > limit);
      return count - 1;
    }
    // Transformed rejection sampling (PTRS), not a normal approximation.
    const b = .931 + 2.53 * Math.sqrt(lambda), a = -.059 + .02483 * b;
    const invAlpha = 1.1239 + 1.1328 / (b - 3.4), vR = .9277 - 3.6224 / (b - 2);
    while (true) {
      const u = random() - .5, v = openRandom(), us = .5 - Math.abs(u);
      if (us === 0) continue;
      const k = Math.floor((2 * a / us + b) * u + lambda + .43);
      if (k < 0) continue;
      if (us >= .07 && v <= vR) return k;
      if (us < .013 && v > us) continue;
      if (Math.log(v * invAlpha / (a / (us * us) + b)) <= -lambda + k * Math.log(lambda) - logGamma(k + 1)) return k;
    }
  }
  return (successes, probability) => {
    if (!successes || probability === 1) return successes;
    if (successes <= 24) {
      let attempts = 0;
      for (let i = 0; i < successes; i++) attempts += Math.floor(Math.log1p(-random()) / Math.log1p(-probability)) + 1;
      return attempts;
    }
    // Failures before r successes: Gamma-Poisson mixture of negative binomial.
    return successes + poisson(gamma(successes) * (1 - probability) / probability);
  };
}

function singleStageQuantile(successes, probability, confidence) {
  if (!successes || probability === 1) return successes;
  let mass = probability ** successes, total = mass, attempts = successes;
  if (mass === 0) return null;
  while (total < confidence && attempts < 1000000) {
    mass *= attempts / (attempts - successes + 1) * (1 - probability);
    total += mass; attempts++;
  }
  return total >= confidence ? attempts : null;
}

/**
 * stages are ordered earliest → final. inventory[i] contains already-created
 * output of stage i, NOT its ingredients. Each stage attempt consumes one unit of
 * the preceding stage by default (inputQuantity may specify another integer).
 * Base/white items listed as stage-0 ingredients belong in materialInventory.
 * q = successRate × comboProbability × comboSuccessRate. Separate combo success
 * is required when activation < 1; unknown is never silently assumed certain.
 *
 * expectedCost and quantileCost are ADDITIONAL cash to buy missing ingredients
 * and pay fees. Existing stock has zero additional cash cost, not zero economic
 * value. Confidence budget assumes prices remain fixed and purchases can be made
 * as needed. It is not a simultaneous per-material stock guarantee.
 */
export function planGear(input = {}) {
  const issues = [], warnings = [], addIssue = text => { if (!issues.includes(text)) issues.push(text); };
  const stages = input.stages, targetCount = input.targetCount ?? 1;
  const confidence = input.confidence ?? .95, iterations = input.iterations ?? 30000;
  const seed = input.seed ?? 20261027;
  const empty = () => ({eligible:false,issues,warnings,expectedAttempts:[],expectedMaterials:[],expectedCost:null,expectedCashOut:null,quantileCost:null,confidence,probabilityAchieved:null,method:'unavailable',iterations:0,seed});
  if (!Array.isArray(stages) || !stages.length || stages.length > 12) addIssue('Потрібен ланцюг від одного до дванадцяти етапів.');
  if (!integer(targetCount) || targetCount < 1 || targetCount > 10000) addIssue('Вкажіть цілу кількість потрібних предметів від 1 до 10000.');
  if (!chance(confidence)) addIssue('Обери допустимий рівень імовірності.');
  if (!integer(iterations) || iterations < 1000 || iterations > 100000) addIssue('Кількість розрахункових сценаріїв має бути від 1000 до 100000.');
  if (!integer(seed) || seed > 4294967295) addIssue('Некоректний початковий стан розрахунку.');
  if (issues.length) return empty();
  if (stages.some(stage=>!stage||typeof stage!=='object'||Array.isArray(stage))) {addIssue('Некоректний етап ланцюга.');return empty();}
  if (input.inventory != null && typeof input.inventory !== 'object') {addIssue('Некоректний список запасів готових предметів.');return empty();}
  const owned = stages.map((stage,i) => {
    const key = Array.isArray(input.inventory) ? i : stage.id;
    return input.inventory && Object.hasOwn(input.inventory,key) ? input.inventory[key] : 0;
  });
  if (owned.some(value => !integer(value))) addIssue('Запаси готових предметів мають бути цілими невід’ємними числами.');
  const rawStock = Object.hasOwn(input,'materialInventory') ? input.materialInventory : {};
  if (!rawStock || typeof rawStock !== 'object' || Array.isArray(rawStock) || Object.values(rawStock).some(value => !nonnegative(value))) addIssue('Некоректні запаси матеріалів.');
  if (issues.length) return empty();
  if (owned.at(-1) >= targetCount) return {eligible:true,issues,warnings:['Потрібна кількість уже є в запасі. Додаткова закупівля не потрібна.'],expectedAttempts:stages.map(()=>0),expectedMaterials:[],expectedCost:0,expectedCashOut:0,quantileCost:0,confidence,probabilityAchieved:1,method:'exact',iterations:0,seed};
  const ids = new Set(), materialMap = new Map();
  const probabilities = [], multipliers = [];
  stages.forEach((stage,i) => {
    if (!stage || typeof stage.id !== 'string' || !stage.id || ids.has(stage.id)) {addIssue('Кожен етап має мати окремий ідентифікатор.');return;}
    ids.add(stage.id);
    if (!chance(stage.successRate) || !chance(stage.comboProbability)) addIssue('Уточни шанс успіху та активації особливого результату кожного етапу.');
    let comboSuccess = stage.comboSuccessRate;
    if (comboSuccess == null && stage.comboProbability === 1 && stage.hasCombo !== true) comboSuccess = 1;
    if (!chance(comboSuccess)) {
      if (comboSuccess == null && input.allowApproximateCombo === true) {comboSuccess = 1;warnings.push('Окремий шанс успіху combo невідомий: явно обрана спрощена модель постачальника. Перевір шанс у грі.');}
      else addIssue('Потрібен окремий шанс успіху combo; активація 25% не означає гарантований успіх combo.');
    }
    probabilities[i] = stage.successRate * stage.comboProbability * comboSuccess;
    const multiplier = stage.inputQuantity ?? 1;
    if (!integer(multiplier) || multiplier < 1) addIssue('Кількість предметів попереднього етапу на спробу має бути цілим додатним числом.');
    multipliers[i] = multiplier;
    if (!nonnegative(stage.fee)) addIssue('Уточни плату за спробу кожного етапу. Нуль потрібно вказати явно.');
    if (!Array.isArray(stage.materials)) {addIssue('Потрібен список матеріалів кожного етапу.');return;}
    for (const row of stage.materials) {
      if (!row || typeof row.id !== 'string' || !row.id || !nonnegative(row.quantity)) {addIssue('Некоректний матеріал або його кількість.');continue;}
      const old = materialMap.get(row.id);
      if (!old) materialMap.set(row.id,{id:row.id,name:row.name ?? row.id,price:nonnegative(row.price)?row.price:null,owned:rawStock[row.id]??0});
      else if (old.price !== row.price) old.price = null;
    }
  });
  if (issues.length) return empty();
  const materials = [...materialMap.values()], materialIndex = new Map(materials.map((row,i)=>[row.id,i]));
  // Even a very rare stock shortage must not become a free price just because
  // it happened not to appear in a finite simulation sample.
  const maximumQuantities=materials.map(()=>0);
  let maximumNeed=Math.max(0,targetCount-owned.at(-1)), randomNeeded=false;
  for(let i=stages.length-1;i>=0;i--){
    const maximumAttempts=maximumNeed===0?0:probabilities[i]===1?maximumNeed:Infinity;
    if(maximumNeed>0&&probabilities[i]<1)randomNeeded=true;
    for(const row of stages[i].materials)if(row.quantity>0)maximumQuantities[materialIndex.get(row.id)]+=maximumAttempts*row.quantity;
    maximumNeed=i>0?Math.max(0,maximumAttempts*multipliers[i]-owned[i-1]):0;
  }
  maximumQuantities.forEach((quantity,i)=>{if(quantity>materials[i].owned&&!nonnegative(materials[i].price))addIssue(`Потрібна ціна матеріалу «${materials[i].name}».`);});
  if (confidence === 1 && randomNeeded) addIssue('За випадкових незалежних спроб немає скінченного бюджету зі 100% гарантією. Обери 95%, 99% або 99,9%.');
  if(issues.length)return empty();
  const expectedAnalytical = stages.map(()=>0);
  let need = Math.max(0,targetCount-owned.at(-1));
  for (let i=stages.length-1;i>=0;i--) {
    expectedAnalytical[i] = need/probabilities[i];
    if (!Number.isFinite(expectedAnalytical[i]) || expectedAnalytical[i]>1e9) addIssue('Ланцюг потребує надто великої кількості спроб для надійного розрахунку.');
    need = Math.max(0,expectedAnalytical[i]*multipliers[i]-(i>0?owned[i-1]:0));
  }
  if (issues.length) return empty();
  const attemptsSum=stages.map(()=>0), quantitiesSum=materials.map(()=>0), boughtSum=materials.map(()=>0), costs=[];
  const sampleAttempts=samplers(randomGenerator(seed));
  const deterministic=probabilities.every(p=>p===1), runs=deterministic?1:iterations;
  let costSum=0,costSquares=0;
  function costOf(attempts) {
    const quantities=materials.map(()=>0);
    let fees=0;
    stages.forEach((stage,i)=>{fees+=attempts[i]*stage.fee;for(const row of stage.materials)quantities[materialIndex.get(row.id)]+=attempts[i]*row.quantity;});
    const bought=quantities.map((quantity,i)=>Math.max(0,quantity-materials[i].owned));
    let cost=fees;
    bought.forEach((quantity,i)=>{if(quantity>0&&!nonnegative(materials[i].price))addIssue(`Потрібна ціна матеріалу «${materials[i].name}».`);else if(quantity>0)cost+=quantity*materials[i].price;});
    return {quantities,bought,cost};
  }
  for(let run=0;run<runs;run++) {
    const attempts=stages.map(()=>0);
    let required=Math.max(0,targetCount-owned.at(-1));
    for(let i=stages.length-1;i>=0;i--) {
      attempts[i]=sampleAttempts(required,probabilities[i]);
      if(!integer(attempts[i])||attempts[i]>1e12) {addIssue('Кількість спроб перевищує межі розрахунку.');return empty();}
      required=Math.max(0,attempts[i]*multipliers[i]-(i>0?owned[i-1]:0));
    }
    const trial=costOf(attempts);
    if(!nonnegative(trial.cost)){addIssue('Вартість перевищує межі розрахунку.');return empty();}
    attempts.forEach((n,i)=>attemptsSum[i]+=n);
    trial.quantities.forEach((n,i)=>quantitiesSum[i]+=n);
    trial.bought.forEach((n,i)=>boughtSum[i]+=n);
    costs.push(trial.cost);costSum+=trial.cost;costSquares+=trial.cost*trial.cost;
  }
  // With no owned intermediate outputs or raw stock, linear expectations are exact.
  const noIntermediateStock=owned.slice(0,-1).every(n=>n===0);
  const noRawStock=materials.every(row=>row.owned===0);
  const expectedAttempts=noIntermediateStock?expectedAnalytical:attemptsSum.map(sum=>sum/runs);
  const exactTrial=noIntermediateStock&&noRawStock?costOf(expectedAttempts):null;
  const expectedMaterials=materials.map((row,i)=>{
    const buyQuantity=exactTrial?exactTrial.bought[i]:boughtSum[i]/runs;
    return {...row,quantity:exactTrial?exactTrial.quantities[i]:quantitiesSum[i]/runs,
      buyQuantity,cost:buyQuantity===0?0:row.price===null?null:buyQuantity*row.price};
  });
  costs.sort((a,b)=>a-b);
  let quantileCost=costs[Math.ceil(confidence*runs)-1],probabilityAchieved=costs.filter(cost=>cost<=quantileCost).length/runs;
  let method=deterministic?'exact':'seeded-monte-carlo';
  if(stages.length===1) {
    const exactAttempts=singleStageQuantile(targetCount-owned[0],probabilities[0],confidence);
    if(exactAttempts!==null){quantileCost=costOf([exactAttempts]).cost;method=deterministic?'exact':'exact-single-stage-with-sampled-stock-mean';
      probabilityAchieved=costs.filter(cost=>cost<=quantileCost).length/runs;
    }
  }
  const expectedCost=exactTrial?exactTrial.cost:costSum/runs;
  const standardErrorCost=runs>1?Math.sqrt(Math.max(0,costSquares/runs-(costSum/runs)**2)/runs):0;
  if(!deterministic)warnings.push('Бюджет із заданою ймовірністю не є гарантією. Рідкісні довгі серії невдач можуть потребувати більше грошей.');
  if(!deterministic&&(!noIntermediateStock||!noRawStock))warnings.push('Очікувані витрати з наявними запасами оцінено відтворюваним моделюванням, а не відніманням запасів від середньої потреби.');
  warnings.push('Наявні запаси не потребують нових грошей, але мають власну економічну вартість. Ціни та доступність матеріалів вважаються незмінними; матеріали можна докуповувати під час крафту.');
  return {eligible:issues.length===0,issues,warnings,expectedAttempts,expectedMaterials,
    expectedCost:issues.length?null:expectedCost,expectedCashOut:issues.length?null:expectedCost,
    quantileCost:issues.length?null:quantileCost,confidence,
    probabilityAchieved:issues.length?null:probabilityAchieved,method,iterations:runs,seed,standardErrorCost};
}
