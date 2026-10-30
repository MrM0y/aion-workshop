import {createTour} from './tour.js';

const screens={craft:'market',gear:'gear',bargains:'bargains'};

/** Steps only describe real controls. Predicates read UI state; no input is filled or clicked. */
export function usageGuideSteps(task,{getContext=()=>({}),document:doc=globalThis.document}={}){
  if(!Object.hasOwn(screens,task))throw new RangeError('Невідомий маршрут підказок.');
  const has=selector=>Boolean(doc?.querySelector(selector));
  const target=(...selectors)=>()=>selectors.find(has)||null;
  // The catalogue is mounted outside its input. Let both stay usable while it is open.
  const chooser=(...selectors)=>()=>has('.recipe-picker:not([hidden])')?'body':target(...selectors)();
  const step=(id,title,text,selector,extra={})=>({id,title,text,selector,...extra});
  const steps=[];
  if(!getContext().serverId)steps.push(step('choose-market','Спершу твій ринок','Натисни тут і вибери регіон, фракцію та сервер. Наступного разу вони вже будуть збережені.',target('#serverForm','#marketPicker','#content'),{advanceWhen:()=>Boolean(getContext().serverId)}));
  if(task==='craft')steps.push(
    step('craft-scan','Знайдемо вигідний крафт','Натисни «Знайти вигідне». Оновлю ціни й порівняю рецепти. Якщо джерело затримується, біля цін залишиться їхній справжній час.',target('#scan','#content'),{advanceWhen:()=>!getContext().scanning&&has('.ranking tbody tr')}),
    step('craft-choose','Знайди потрібну річ','Можеш вписати назву або натиснути поле й пройти категоріями. Потім відкрий рецепт у списку.',chooser('#modal .modal','.toolbar','#content'),{advanceWhen:()=>has('#purchaseWorkspace')}),
    step('craft-budget','Скільки хочеш зробити?','У відкритому рецепті задай кількість спроб або бюджет. Не знаєш поки — залиш як є. Натисни «Розрахувати».',target('.pp-controls','#modal .modal','#ranked','#content')),
    step('craft-result','Ось що треба купити','У підсумку видно лоти, кількості й усю суму. Якщо кількостей у джерелі немає, їх не вигадую. Прибуток залежить від того, чи продаси готовий товар.',target('.pp-state','#purchaseWorkspace','#modal .modal','#ranked','#content')),
    step('craft-market','Перевір ціну й попит','Відкрий «Історія ціни» внизу рецепта. Велика різниця в ціні ще не означає швидкий продаж.',target('.market-insights','#recipeSales','#modal .modal','#content'))
  );
  if(task==='gear')steps.push(
    step('gear-target','Яку річ хочеш отримати?','Обери зброю, броню чи прикрасу. Можна шукати за назвою або відкрити категорії.',chooser('.gv-target','#gearWorkspace','#content')),
    step('gear-start','З чого починаємо?','Вибери, з чого почати: із сировини чи з купівлі проміжної речі.',target('.gv-form','#gearWorkspace','#content')),
    step('gear-calculate','Порахуємо невдалі спроби','Натисни «Розрахувати». Вибір «У 99 зі 100 випадків» означає більший запас грошей на невдачі; абсолютної гарантії випадкового крафту немає.',target('.gv-form','#gearWorkspace','#content')),
    step('gear-result','Загальна сума — тут','Вгорі підсумку будуть середні витрати й бюджет із запасом. Поруч — матеріали та скільки ще купити. Якщо бракує шансів або цін, покажу це замість вигаданої суми.',target('.gv-summary','#gearWorkspace','#content'))
  );
  if(task==='bargains')steps.push(
    step('bargains-purpose','Для чого купуєш?','Для крафту шукаємо економію на матеріалах. Для перепродажу додатково враховуємо податок і запас — це різні розрахунки.',target('[data-bargain-purpose]','.bargain-controls','#content')),
    step('bargains-budget','Який бюджет?','Можеш вказати суму — тоді не запропоную більше доступних одиниць, ніж можеш оплатити. Порожнє поле теж підходить.',target('[data-bargain-budget]','.bargain-controls','#content')),
    step('bargains-scan','Шукаю дешевше звичного','Перевірка починається сама. Кнопка «Знайти дешевше» повторює її. Результати з’являються поступово; для повного списку дочекайся завершення.',target('[data-bargain-scan]','.bargain-view','#content')),
    step('bargains-result','Подивись на різницю й кількість','Тут видно поточну й звичну ціну, доступні лоти та суму закупівлі. Позначка падіння ціни допомагає не сплутати тривалий спад із випадковою знижкою.',target('.bargain-results','.bargain-panel','#content')),
    step('bargains-inspect','Відкрий предмет, щоб придивитися','Натисни рядок — відкриється графік. Економія порівнюється з історією оголошень; це ще не зароблений прибуток і не гарантія продажу.',target('.bargain-results','#content'))
  );
  return steps;
}

/** Starts only after an explicit task choice. The host owns menus, first-run policy and persistence. */
export function createUsageGuide({navigate=()=>{},getContext=()=>({}),onComplete=()=>{},document:doc=globalThis.document,tourFactory=createTour}={}){
  let task=null,request=0;
  const tour=tourFactory({onComplete:info=>{const completed=task;task=null;onComplete({task:completed,...info});},onStop:()=>{task=null;}});
  return {
    async start(nextTask){
      if(!Object.hasOwn(screens,nextTask))throw new RangeError('Невідомий маршрут підказок.');
      const current=++request;tour.stop('restarted');await navigate(screens[nextTask]);
      if(current!==request)return false;
      task=nextTask;return tour.start(usageGuideSteps(nextTask,{getContext,document:doc}));
    },
    refresh(){tour.refresh();},
    stop(reason='closed'){request++;task=null;tour.stop(reason);},
    get active(){return tour.active;}
  };
}
