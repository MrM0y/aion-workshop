# AION 2: джерела попиту, глибини ринку та часу продажу

Перевірено 27.10.2026. Це запис дослідження, не обіцянка точного прогнозу. Код застосунку під час цього дослідження не змінювався.

## Висновок для поточної реалізації

Для Global Nemon не знайдено підтвердженого публічного потоку завершених угод з часом, ціною та кількістю. Є спостереження оголошень, історія мінімальної ціни, агрегати продажів із заданим часовим вікном, а для деяких предметів — історична глибина оголошень. Цього достатньо для чесних графіків ціни, пропозиції й опублікованого обсягу. Для заяви «цю партію за цією ціною куплять за дві хвилини з імовірністю X» цього недостатньо без суттєвих модельних припущень.

Найкорисніше уточнення: корейський AEID має інший живий публічний read API. Проте він дає KR world/faction ціни та індикатор активності, не цінозалежний потік угод Nemon. Не переносити такі числа на Global.

## Перевірені джерела

### 1. Офіційний PLAYNC Developers: не підміняти AION 2 іншою грою

- https://developers.plaync.com/
- https://developers.plaync.com/apis/l2m/search?locale=ko-KR
- https://developers.plaync.com/apis/l2m/price
- https://developers.plaync.com/support/guide

Індексована документація містить `/market/items/search`, `/market/items/{item_id}/price`, `/market/servers`, але вони прямо позначені **Lineage 2M**. API key цього порталу не є доказом доступності AION 2 market API. У проведеному пошуку не знайдено офіційної документації AION 2 trades/orderbook. Відсутність знайденої документації не доводить відсутність усіх внутрішніх чи партнерських API.

### 2. Aion2Market: Global server-specific спостереження

- https://aion2.exchange/
- https://aion2.exchange/api/items/610511013?server=11304
- https://aion2.exchange/api/items/610511013/volume?server=11304

GET перевірені без акаунта, HTTP 200 через стандартний Node fetch. Item detail на момент перевірки мав `item_key`, `name`, `category`, `on_market`, `price`, `listings`, `captured_at`, `first_seen_at`, `snapshots`, `has_statistics`, `statistics`, `depth_latest_at`. Приклад `statistics`: `registered=2026-10-27T15:00:00Z`, `units_sold=25265`, `avg_price=2480000`, `min_price=1340000`, `max_price=4500000`, `window_from=2026-09-29T15:00:00Z`, `window_to=2026-10-27T14:59:59.999Z`. Це 28-денний агрегат, не продажі за сьогодні.

`depth_latest_at=2026-10-06T11:51:36.897Z` у цього прикладу підтверджує наявність старої глибини, але не її актуальність 27 жовтня. Маршрут глибини та перевірку її свіжості паралельно дослідив агент market_research. Ціна 11304 (EU Kaisinel Elyos) не є ціною 12309 (EU Nemon Asmodian).

`/volume` повертає `days[]`: `registered`, `units_sold`, `previous_units_sold`, `units_delta`, `days_since_previous`, `avg_price`, `min_price`, `max_price`, `window_from`, `window_to`, `last_fetched_at`, `observations`, `variants`. Публічні поля не містять часу кожної завершеної угоди. Годинні snapshots оголошень не перетворюються на годинні trades.

### 3. AEID: перевірений альтернативний KR adapter, не Global telemetry

Першоджерела:

- https://aeid.gg/
- https://aeid.gg/assets/index-DhWHtLoQ.js — публічний frontend, актуальний hash на момент перевірки; використовувався для знаходження маршрутів, код не виконувався.
- https://www.inven.co.kr/board/aion2/6388/62715 — допис самого розробника 08.01.2026.

Автор описує послідовний цикл worldmarket спостережень приблизно 20–30 хвилин, історію останніх десяти цін, можливість ручної зміни ціни та прапорець низької активності. Старий домен `aeid.lostgld.com` переадресовує на `aeid.gg`. Це опис автором свого сервісу, не верифікація NCSOFT. Його старі припущення про шанси й корейські комісії не слід брати для Global.

У frontend виявлено base `https://api-aeid.lostgld.com`; підтверджено read GET 200:

| Маршрут | Реальні поля | Межі |
|---|---|---|
| `/prices?faction=asmo` | Об’єкт за корейською назвою: `name`, `price`, `last_updated`, `activity_score`, `trend` | У дослідженому виклику немає Global region/server; часовий пояс рядків без offset не підтверджено |
| `/price-history/{encodeURIComponent(KoreanName)}?faction=asmo` | Масив десяти `{price,time,is_changed}` | Спостереження зміни ціни, не угоди |
| `/graph-prices/{encodeURIComponent(KoreanName)}?faction=asmo&period=day` | Для перевіреного предмета повернув `[]` | Немає даних — не малювати вигадану лінію |

Приклад предмета `기룡왕의 가더`: десять цін за 01.07.2026, хоча дослідження було в жовтні; `graph-prices` порожній. У `/prices` частина записів оновлена 26.10, частина лишилася з липня/серпня.

Додаткова емпірична перевірка на трьох предметах:

| Предмет | activity_score | is_changed=true серед останніх 10 |
|---|---:|---:|
| 달인의 빛나는 오리하르콘 장갑 | 70 | 7 |
| 빛나는 건룡왕의 장갑 | 0 | 0 |
| 빛나는 흑룡왕의 장갑 | 50 | 5 |

Це сильне співпадіння з часткою змінених цін, але опублікованої формули не знайдено. **Не називати activity_score кількістю угод або шансом продажу.** Навіть стабільна ціна може мати великі продажі, а зміна ціни може бути новою пропозицією без жодного продажу.

### 4. Atool: ціни вводять люди

- https://aion2tool.com/craft
- https://aion2tool.com/

Сторінка craft прямо пояснює: ціни матеріалів і товарів вводяться користувачами та спільно використовуються як довідкові. Головна описує відсіювання викидів і медіану спільних цін. Це корисна модель ручних виправлень, але не автоматичний журнал угод. KR/TW/Global мають окремі перемикачі; сама наявність регіонів не робить ціну одного регіону придатною іншому.

### 5. Global client-derived Supply Requests: статичний список не є активним календарем сервера

- https://aion2.gg/tools/supply-requests

Автор сервісу зазначає, що конкретні заявки обирає сервер, а гравець відмічає побачені у грі. Каталог містить можливі заявки та кількість предметів, але не підтверджує початок/кінець конкретного прохання на Nemon. Та сама сторінка заявляє відсутність публічного NCSOFT Market API і тому використовує ручні ціни. Це первинний опис меж власного інструмента.

Для графіка допустимі маркери лише з `market scope + requestId + observedStart/observedEnd + provenance`. Відомий список можливих товарів не дає права розставляти «подія почалась» заднім числом на кожному стрибку ціни. Стрибок та подія можуть корелювати; причинність не встановлена.

### 6. Відкритий Global dataset із listing IDs: придатний для дослідження формату

- https://github.com/dimkk/aion2-market-stack
- https://raw.githubusercontent.com/dimkk/aion2-market-stack/main/data/seed/README.md
- https://raw.githubusercontent.com/dimkk/aion2-market-stack/main/data/seed/manifest.json

Підтверджений manifest: build `25650019`, 1 102 summary runs, 314 803 summary rows, 101 scope; 23 799 listing observations, **deep listings лише у двох scopes**. Діапазон 04.10.2026 22:19 UTC — 10.10.2026 12:16 UTC. README перелічує item/listing IDs, кількості, ціни, умови та provenance. Це історичні спостереження, не актуальний hosted API, не підтвердження завершеної угоди й не повний ринок. Репозиторій не встановлювався, collector не запускався, авторизація гри не використовувалась.

### 7. KR/TW історичні ціни — порівняння фаз, не час продажу

- https://github.com/shizukaziye/aion2-market-history

Власний README пояснює метод: KR/TW — вручну переписані цитати форумів із джерелом на кожній точці; Global — добові медіани найнижчих оголошень із Aion2Market для шести серверів. Такі точки допомагають побачити довгі цінові цикли. Вони не є price-level book або вибіркою sale durations. `rough` без числового підтвердження не прирівнюється до спостереженої ціни.

### 8. Джерела, які виглядають схоже, але не розв’язують задачу

- https://6sword.com/zh-TW/changelog — multi-game сайт. Його market statistics / daily price changes у знайденому changelog належать, зокрема, **Lineage 2M / Lineage M / Lineage Classic**. Не переносити їх API в AION 2.
- https://daevahub.com/about/ — власна методика сайту підтверджує Global asking prices з Aion2Market приблизно щогодини, а не завершені продажі. Це не незалежний другий feed.
- RMT-майданчики на кшталт Itembay, DD373, Gamebit, Gemdex: кількість продажів реальної валюти/акаунтів не дорівнює внутрішньоігровому попиту на конкретне зілля. Не використовувати для lambda продажу предмета.

## Rolling aggregates: точна математика та межі ідентифікації

Нехай `S_d` — реальні продажі в день d, а `V_d=sum(S_(d-27)..S_d)` — рівно 28 днів. Тоді:

```text
V_d - V_(d-1) = S_d - S_(d-28)
S_d = V_d - V_(d-1) + S_(d-28)
```

Проста delta не дорівнює денним продажам, коли старі продажі виходять із вікна. Теоретично відновлення можливе з повною однорідною історією, відомими нульовими значеннями до запуску, однаковими варіантами товару, часовими межами, лічильником без скидань і переглядів.

Офіційний старт Global підтверджено через Steam announcement API:

- https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=3393110&count=100&maxlength=0
- https://store.steampowered.com/news/app/3393110/view/1844115010496396 — NC: Advanced Access з 30.09, загальний запуск 05.10.
- https://store.steampowered.com/news/app/3393110/view/1845383656377843 — NC: Nemon доданий 02.10, 03:00 PDT.

Це робить prelaunch zero аргумент математично можливим, але **самої дати запуску недостатньо**: агент market_research спостеріг агрегат Grilled Cypri 221 → 0 → 265 04–06 жовтня, коли вилучене вікно ще було до запуску. Отже покриття, reset або семантика лічильника нестабільні. Без окремого аудиту такі delta не мають автоматично ставати daily sales.

`units_sold / exactWindowDays` можна показувати тільки як **середнє за опубліковане вікно**. Воно не доводить нинішню швидкість попиту; на новому сервері вікно ще й містить дні до його відкриття. Не називати результат actual last-24h sales.

## Формула сценарію часу продажу

Проста черга — наша модельна пропозиція, не властивість AION 2, яку підтвердив провайдер. Стандартний Poisson CDF: https://www.itl.nist.gov/div898/handbook/eda/section3/eda366j.htm . Припущення постійного потоку й експоненційних міжподійних інтервалів: https://www.itl.nist.gov/div898/handbook/apr/section1/apr171.htm .

Нехай при ціні p:

- `A(p)` — **кількість одиниць**, що стоять попереду, не кількість оголошень;
- q — наша кількість;
- `lambda(p)` — покупці/одиниці за годину, які справді готові купити за p;
- кожна подія купує одну одиницю, спочатку очищаються дешевші/раніше виставлені позиції;
- нових дешевших позицій, скасувань, зміни ціни та подій попиту немає.

Тоді для повного продажу партії потрібні `k=A(p)+q` подій:

```text
P(T_all <= t) = P(Poisson(lambda(p)*t) >= k)
             = 1 - exp(-lambda(p)*t) * sum(j=0..k-1) ((lambda(p)*t)^j / j!)
E[T_all] = k / lambda(p)
```

Це Erlang waiting-time model. Для першої проданої одиниці k=A+1. Потрібно явно відрізняти перший продаж від повного продажу партії. За пакетних покупок потрібна модель розмірів покупки (compound arrivals), а не ця одинична формула. Непідтверджений порядок рівних цін дає щонайменше інтервал черги: дешевші одиниці vs дешевші плюс усі рівноцінні.

Слабкі ланки для поточних джерел:

1. Старий depth дає старе A, не поточне.
2. Загальний обсяг товару не ідентифікує `lambda(p)` за ціною вище низу ринку.
3. 28-денне середнє не ідентифікує попит у наступні дві хвилини; денні/тижневі цикли й поставки порушують сталість.
4. Зникнення оголошення може бути купівлею, скасуванням, закінченням чи пропуском спостереження. Це не мітка завершеної угоди.

Тому навіть коректно порахований CDF треба називати **сценарієм за заданим середнім темпом**, а не емпірично підтвердженим шансом продажу. За відсутності свіжої глибини або придатного темпу — результат невідомий, не нуль і не «3 дні».

## Як отримати кращий прогноз надалі

Мінімальна локальна подія: `region/marketType/server/faction`, itemId/variant/build, listingId, price, quantity, postedAt/firstObservedAt, observations, partial fill times/quantities, `sold|cancelled|expired|unknown`, завершення спостереження. Не зберігати ідентифікацій продавця чи секрети сесії для цієї моделі.

Для підтверджених власних продажів можна оцінювати survival curve за близьким відношенням ціни до ринку й глибиною черги. Непродані на кінець спостереження позиції є right-censored; скасування можуть бути інформативними і потребують окремої моделі, а не автоматичного прирівнювання до незалежного censoring. Підґрунтя: https://itl.nist.gov/div898/handbook/apr/section2/apr215.htm та https://itl.nist.gov/div898/handbook/apr/section1/apr131.htm .

Якщо час відомий лише між двома scans, дані interval-censored; точний Kaplan–Meier без адаптації непридатний. Для заяви «2 хвилини» потрібна відповідна частота спостережень і підтвердження sold, не годинні polling snapshots. Калібрацію перевіряти на майбутніх інтервалах, окремо за сервером/предметом/ціновим сегментом; оцінювати покриття прогнозних інтервалів і calibration ймовірностей.

Мета вибору ціни також має бути явною. Для горизонту H й грошей, що реально повернуться:

```text
ExpectedCashProfit(H,p) = p*(1-saleTax)*E[unitsSoldBy(H,p)]
                       - craftCost - initialListingFee - expectedRelistingFees
```

Непроданий залишок — окремий актив; він не стає заробленими грошима до продажу. «Оптимальну ціну» без горизонту, моделі цінозалежного попиту й припущення щодо непроданого залишку неможливо визначити однозначно.

## Проста подача у UI

Під підсумком рецепта достатньо одного блоку: графік ціни, поруч графік фактично доступного обсягу/пропозиції з правильною назвою величини; три компактні числа «низ зараз / типовий рівень / оголошень». Рівні ціни показувати лише за реальною свіжою глибиною. Маркери поставок — лише підтверджені для обраного ринку.

Час продажу з моделі показувати одним коротким рядком із словом «сценарій» і доступними припущеннями в розгортанні. Якщо source не дозволяє відрізнити дві хвилини від трьох днів, прямо залишати цей прогноз невизначеним, замість красивого вигаданого відсотка.


---

# Market insight source audit — 2026-10-27

Primary provider contract: https://aion2.exchange/api/openapi.json
Public UI source: https://aion2.exchange/assets/index-CqXpNCAB.js and ItemPage-CLkeGrUq.js.

Available data:
- /api/items/:id/prices?server&range supplies timestamps, low/high/avg/close of observed cheapest listing prices, listing counts and bucket size.
- /api/items/:id/volume?server supplies one daily observation of rolling 28-day sales totals, average/minimum/maximum sale prices, exact window boundaries. A day-to-day delta is the quantity entering the window minus the quantity leaving it. It is NOT daily purchases. Algebra: C(t)-C(t-1)=D(t)-D(t-28).
- /api/items/:id/observations?server&range supplies each FETCH of those rolling statistics. It does not expose individual trades. A Radiant Odyle example for EU11304 returned one observation in 24 hours.
- /api/items/:id/depth/ladder?server supplies a captured_at snapshot of actual price levels: unit_price, listings, units, cum_units, cum_cost; complete=false means only cheapest available listings were captured.
- /api/items/:id/depth?server&units=N&range supplies historical acquisition cost for N units. cost_stacks/units_stacks differ where whole-stack buying would overbuy. The site's UI says whether stacks can be partially bought is unknown.

Observed coverage:
- Curry Meat Stirfry 510716013, Nemon Asmodian 12309: price history available, 19 listings at 14,999 in the inspected snapshot; /volume days=[]; /depth/ladder captured_at=null and levels=[]. No honest quantity-at-18,000 or sale-delay estimate can be extracted from this snapshot.
- Radiant Odyle 610610016, EU11304: both volume and depth exist, but depth snapshot inspected is 2026-10-06 (old); not a current selling queue. Do not mix this server's statistics into Nemon.

Estimated waiting time:
The actual 28-day total divided by its exact window duration gives a historical mean flow across all prices, not current demand at a proposed price. Queue time (units ahead + lot size) / historical mean flow is only a conditional queue-clearing scenario: assumes cheaper-price-first, constant flow, no new competing offers, no cancellations, divisible stacks / known matching priority. It cannot justify '15k sells in 2 minutes, 17k in 10 minutes, 25k in 3 days'. Price-specific willingness to pay, order-matching rules and timestamped trades are absent. Published OpenAPI has no trades/transactions route.

Supply request markers:
https://aion2.gg/tools/supply-requests lists client request eligibility, asks users to tick requests currently shown in the game and says the server chooses actual active requests. https://aion2data.com/item-collections/elyos-emergency says deadline dates are set by the server. Client period slots are not confirmed live server event start/end dates. The new backend therefore stores user-entered intervals with source='manual'; it never infers a supply event from a price spike.

Implemented backend:
GET /api/insights?server=ID&item=ID&range=3h|24h|7d|30d
returns prices, demand, supply, depth, current, events, sources, warnings, persisted.
POST /api/insights/events JSON {server,item,at,endAt?,label}; local Origin required.
DELETE /api/insights/events?server&item&id; local Origin required.

History is retained separately from UI state in statePath+'.history', injectable as historyPath. Real timestamps survive merges and source failures. Retention 730 days, max 30k price points / 1200 sales observations / 500 event markers per item. Corrupt history is reported rather than silently reset. Tests cover persistence, duplicate timestamps, stale depth, missing sales, manual markers, corruption, retention and HTTP write Origin boundaries.


## Повторна перевірка попиту · 28.10.2026

Первинні джерела перевірено повторно:
- https://aion2.exchange/ прямо називає зниклі оголошення sold/cancelled/expired; Units sold — рухомий28-денний підсумок, опублікований раз на добу.
- Автор провайдера пояснював у https://www.reddit.com/r/Aion2/comments/1wyrc6m/aion_2_market_data/ обмежене серверне покриття статистики rate limits. Це пояснення автора на дату коментаря, а не гарантія незмінного поточного покриття.
- Поточний API Nemon12309, Curry510716013: /volume days=[]; detail.has_statistics=false, statistics=null, depth_latest_at=null. Тобто підтверджений потік скупки саме для цього предмета не з’явився.
- https://a2-tracker.com/ прямо повідомляє, що має asking prices, але не completed trades чи sales volume.
- https://www.aion2.market/ також публікує спостережені ціни й каже, що listings не дорівнюють sales.
- https://github.com/dimkk/aion2-market-stack має індивідуальні listing observations, але є експериментальним self-hosted collector, не поточним загальнодоступним потоком підтверджених угод.

Практичний доступний сигнал: D=Σmax(0,Cprev−Ccurr), A=Σmax(0,Ccurr−Cprev) для однієї fixed24h відповіді з одним bucket. Це суми спостережених спадів/підйомів пропозиції. Нові й зниклі лоти можуть взаємно приховуватись; повторне виставлення може враховуватись кілька разів. Немає підстав прирівнювати D до підтверджених покупок або виводити калібровану ймовірність продажу.

Жива перевірка:24знімки,23інтервали,0великих пропусків;27.10 05:10UTC—28.10 04:10UTC; спостережені спади1, підйоми18, ціна−21,063%. Значення стосуються цього конкретного запиту, не є сталими.

## Перевірка ліквідності · 28.10.2026

Незалежний критик повторно перевірив первинні API https://aion2.exchange/api/openapi.json та https://aion2.exchange/api/items/510716013?server=12309. Для curry/Nemon: has_statistics=false, statistics=null, depth_latest_at=null. Наявність мінімальної ціни не означає продажів. Bulk-статистика має дату реєстрації та кількість/середню ціну, але не межі вікна: добовий потік чи середній час очікування з неї не обчислюються. Фільтр продажів вимагає окремих свіжих даних для всіх реалізованих результатів рецепта.

## Автоматичні лоти та нове джерело · 28.10.2026

Живі первинні запити: https://aion2.exchange/api/items/610531001?server=12309 повернув meat ID610531001, 21 оголошення, ціну2678, captured_at2026-10-28T15:10:06.838Z, has_statistics=false, statistics=null, depth_latest_at=null. /depth/ladder для нього: captured_at=null, levels=[], units_total=0; це відсутній знімок, не нуль доступного товару. Curry510716013 /volume: days=[].

https://kinahledger.com/market/ використовує asking prices й публічно заперечує sales feed. Новіший первинний код https://github.com/StevenMacchia/kinah-ledger уже має власні sales/expired події та hours_listed. Схема: tracker/KinahLedger.Tracker/Upload/RunPayload.cs; читання: Session/GameWatcher.cs; PriceBook.ParseQuotes читає items[].item, price, price_from, readings, sure, price_seen_at. Код зіставляє Nemon Asmodian з eu-nemon-asmodian. GET https://kinahledger.com/prices/eu-nemon-asmodian.json при перевірці повернув403. Публічну книгу цінових рівнів чи розподіл часу продажу не підтверджено, інтеграція не видається за діючу. Own-sale pairing може неоднозначно зіставляти часткові/повторні лоти. Трекер не встановлювався й не запускався.


## Калькулятор, перенесення та ефір · 31.10.2026

- Клієнтські дані [Dark Dragon Lord Greatsword](https://aion2.gg/database/recipes/dark-dragon-lord-greatsword-121023012) і [Splendent Ebony Dragon Lord Greatsword](https://aion2.gg/database/recipes/splendent-ebony-dragon-lord-greatsword-121023015) явно показують гарантоване перенесення; для першого окремо вказано 25% COMBO. Застосування до однойменного донорного сімейства з нульовим mastery — правило типу рецепта, а не трактування будь-якого null як 100%. Фільтр правила та джерела містяться у transfer-rules.js. Невідомі інші рецепти залишаються невідомими.
- Якщо звичайний результат попереднього крафту можна перенести в його COMBO, умовна частка вже готових речей становить q_combo / (q_normal + q_combo). Вона пропускає наступне гарантоване перенесення, а невдачі попереднього крафту залишаються. Куплений звичайний донор не отримує такого шансу заднім числом.
- 42 відповідності для переробки ресурсів перевірені по фракції та grade. Однакові назви спорядження з різними ID не ототожнюються; доступні лоти й продані одиниці не домислюються.
- Для компонування використано принцип пов’язаних ключів/значень і дій із [GOV.UK Summary list](https://design-system.service.gov.uk/components/summary-list/): підсумки поруч, таблиця матеріалів окремо, допоміжні подробиці розкриваються за потреби.
