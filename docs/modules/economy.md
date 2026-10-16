# Ekonomia

Włącz moduł **Ekonomia** w panelu V1 lub V2 (grupa z Poziomami). Wszystko ustawiasz w panelu — bez edycji kodu. Po aktualizacji bota zarejestruj komendy (`REGISTER_COMMANDS_ON_START=true` i restart).

Monety są wirtualne, nie mają wartości w prawdziwym świecie, a gry nie używają prawdziwych pieniędzy.

## Komendy

| Komenda | Działanie |
| --- | --- |
| `/ekonomia saldo [uzytkownik]` | Saldo, miejsce w rankingu i passa. |
| `/ekonomia daily` | Dzienna nagroda z passą i licznikiem do kolejnego odbioru. |
| `/ekonomia top` | Najbogatsi członkowie. |
| `/ekonomia przekaz <komu> <kwota>` | Przelew (opcjonalna prowizja). |
| `/gry coinflip`, `zgadnij`, `rps`, `kostka`, `sloty`, `blackjack`, `poker`, `ruletka`, `kubki` | Mini-gry za monety. |
| `/kup lista`, `/kup rola <rola>` | Sklep z rolami. |
| `/level profil`, `/level top` | Poziomy (skróty do `/rank` i `/leaderboard`). |

## Ustawienia w panelu

- **Waluta**: nazwa, emoji, saldo startowe.
- **Dzienne nagrody**: włącznik, odstęp między odbiorami, dodatkowy czas na utrzymanie passy, osobna nagroda dla każdego dnia (Dzień 1, Dzień 2…) oraz zapętlanie cyklu.
- **Nagrody za poziomy**: włącznik, stała kwota albo kwota × osiągnięty poziom, premie na wybranych poziomach i komunikat o wypłacie. Wymaga włączonego modułu Poziomy. Przy skoku o kilka poziomów wypłacany jest każdy zdobyty poziom (maks. 200).
- **Przelewy**: włącznik, minimalna kwota, prowizja (0–50%).
- **Sklep z rolami**: role i ceny. Rola bota musi być wyżej niż sprzedawane role i potrzebne jest uprawnienie Zarządzanie rolami.
- **Gry**: włącznik (domyślnie wyłączone), minimalna i maksymalna stawka, przerwa między grami i opcjonalna lista kanałów.

Zapis działa od razu, bez restartu bota.

## Szanse w grach

Każda gra faworyzuje kasyno (zwrot dla gracza poniżej 100%): ruletka ma 15 pól (0 zielone ×14, czerwone/czarne ×2), sloty ok. 84%, zgadnij ×4 z 5, kubki ×2,5 z 3, orzeł/reszka ×2, kostka ×2 (remis zwraca stawkę). W blackjacku naturalne 21 płaci ×2,5. Poker to 5 kart przeciwko botowi (remis zwraca stawkę). `rps` jest bez stawki.

## Ograniczenia

- Restart bota w trakcie partii blackjacka traci stawkę z tej partii.
- Salda są atomowe: równoczesne kliknięcia nie podwoją nagrody ani nie pozwolą wydać więcej niż się ma.
- Dane użytkownika są objęte `/forget` i eksportem danych.
