const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const probability = value => known(value) && value <= 1;
const taxesReady = settings => settings?.taxConfirmed === true && known(settings.saleTax) && known(settings.listingTax) && settings.saleTax + settings.listingTax < 100;
const action = (kind, title, body, button, extra = {}) => ({kind,title,body,button,...extra});
const taxAction = () => action('tax','Спочатку перевіримо податки','Вкажи комісії свого ринку й підтвердь їх. Тоді прибуток буде пораховано після всіх податків.','Перевірити податки');
const readyAction = () => action('ready','Усе для розрахунку є','Можна порівнювати витрати й очікуваний прибуток. Перед закупівлею перевір давність цін.','Переглянути розрахунок');

/** One concrete next step, never a list of internal calculation errors. */
export function nextRecipeAction(recipe, result, settings = {}) {
  if (!taxesReady(settings)) return taxAction();
  if (!recipe) return action('recipe','Оберімо рецепт','Вибери рецепт зі списку або додай свій. Потім перевіримо ціни й витрати.','Обрати рецепт');
  const chain = Array.isArray(recipe.steps) && recipe.steps.length > 0;
  const steps = chain ? recipe.steps : [recipe];
  if (steps.some(step => !known(step.craftFee ?? recipe.craftFee))) {
    return action('fee','Скільки коштує спроба?',recipe.imported
      ? 'Впиши додаткову плату за крафт із гри. Якщо безкоштовно — постав 0.'
      : 'Впиши плату за одну спробу. Якщо безкоштовно — постав 0.',
    'Вказати плату',{fieldId:'craftFee'});
  }
  const rows = Array.isArray(result?.rows) ? result.rows : recipe.rows ?? [];
  const missingMaterial = rows.find(row => !known(row.price));
  if (missingMaterial) return action('materialPrice','Потрібна ціна матеріалу',`Перевір у грі, скільки коштує «${missingMaterial.name || 'цей матеріал'}» за одну штуку, і впиши ціну. Вона збережеться для цього ринку.`,
    'Вписати ціну',{itemId:String(missingMaterial.id)});
  const explicit = !chain && Array.isArray(recipe.outcomes) && recipe.outcomes.length > 0;
  if (explicit) {
    const outcomeRows = Array.isArray(result?.outcomeRows) ? result.outcomeRows : recipe.outcomes;
    const missing = outcomeRows.find(row => row.probability !== 0 && !known(row.price));
    if (missing) return action('salePrice','За скільки продаватимемо?',`Впиши ціну продажу «${missing.name || 'цього результату'}» за одну штуку. Без неї не можна оцінити виручку від усіх результатів.`,
      'Вказати ціну продажу',{itemId:String(missing.id)});
  } else if (!known(result ? result.price : recipe.price)) {
    return action('salePrice','За скільки продаватимемо?','Впиши ціну продажу готового предмета за одну штуку. Програма відніме комісії від виручки.',
      'Вказати ціну продажу',{fieldId:'salePrice',itemId:String(recipe.id)});
  }
  if (explicit) {
    const sum = recipe.outcomes.reduce((total,row) => total + (probability(row.probability) ? row.probability : NaN),0);
    if (!probability(sum) || sum === 0) return action('chance','Уточнімо шанси результатів','Перевір шанси звичайного та особливого результатів у рецепті. Без цих правил програма не зможе врахувати невдачі.',
      'Перевірити шанси',{fieldId:'recipeOutcomes'});
  } else {
    if (steps.some(step => !probability(step.successRate) || step.successRate === 0)) return action('chance','Уточнімо шанс успіху','Шанс успіху не вказаний або не дозволяє отримати предмет. Перевір правила рецепта; програма не підставляє шанс сама.',
      'Перевірити шанс',{fieldId:'recipeSuccess'});
    if (steps.some(step => {
      const combo = step.comboProbability ?? (recipe.specialTarget ? null : 1);
      return !probability(combo) || combo === 0;
    })) return action('chance','Уточнімо особливий результат','Шанс особливого результату невідомий або некоректний. Перевір його в правилах рецепта, щоб не завищити прибуток.',
      'Перевірити шанс',{fieldId:'recipeCombo'});
  }
  if (settings.includeSpecial === false && ((explicit && recipe.outcomes.length > 1) || (recipe.specialTarget && !recipe.regularResult))) {
    return action('special','Для цього рецепта потрібні особливі результати','Зараз їх вимкнено. Увімкни врахування особливих результатів: ціну рідкісного предмета не можна застосовувати до звичайного.',
      'Змінити умови');
  }
  if (result?.eligible === true) return readyAction();
  if (result?.investment === 0) return action('recipe','Перевірмо витрати рецепта','У розрахунку вкладення дорівнюють нулю, тому приріст у відсотках визначити не можна. Перевір кількості матеріалів і плату за спробу.','Перевірити рецепт');
  return action('recipe','Рецепт ще потребує уточнення','Перевір кількості матеріалів, вихід і додаткові результати. Зараз даних недостатньо для надійного порівняння.','Перевірити рецепт');
}

/** Consolidate a market-wide blocker into a single action instead of N errors. */
export function marketNextAction(entries = [], settings = {}) {
  if (!entries.length) return {...action('recipe','Додаймо перший рецепт','Онови каталог свого сервера або додай рецепт із гри. Потім програма допоможе перевірити його вигоду.','Додати рецепт'),recipeId:null};
  if (!taxesReady(settings)) return {...taxAction(),recipeId:null};
  const ready = entries.find(entry => entry.result?.eligible === true);
  if (ready) return {...readyAction(),recipeId:ready.recipe?.id ?? null};
  const first = entries[0];
  return {...nextRecipeAction(first.recipe,first.result,settings),recipeId:first.recipe?.id ?? null};
}
