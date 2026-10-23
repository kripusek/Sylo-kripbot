# Rynki predykcyjne

Włącz moduł **Rynki** (grupa z Ekonomią) w panelu V1 lub V2. Wymaga włączonego modułu **Ekonomia** — zakłady są płatne jej wirtualnymi monetami. Po aktualizacji bota zarejestruj komendy (`REGISTER_COMMANDS_ON_START=true` i restart).

Monety nie mają wartości w prawdziwym świecie. Rynki działają wyłącznie na wirtualne monety; nie ma prawdziwych pieniędzy, wypłat ani skrzynek.

## Jak to działa

Rynek to pytanie z 2–10 opcjami, wysyłane na kanał jako wiadomość z przyciskiem pod każdą opcją. Członek klika opcję, wpisuje stawkę w oknie i płaci monetami z konta. Można postawić wiele razy, także na różne opcje.

Po rozstrzygnięciu **cała pula dzieli się między osoby, które postawiły na zwycięską opcję**, proporcjonalnie do ich stawek (system pul, jak totalizator). Monety tylko przechodzą między członkami — nie powstają z niczego (resztki z zaokrągleń znikają). Jeśli nikt nie postawił na zwycięską opcję albo rynek anulujesz, **wszyscy dostają stawki z powrotem**. Przy każdej opcji widać pulę, udział w puli i mnożnik przy obecnym podziale.

## Rynki z Polymarketa

W panelu wklej adres rynku z polymarket.com albo wybierz z listy najpopularniejszych. Bot pobiera pytanie, opcje i procenty z publicznego, darmowego API Polymarketa (bez klucza, tylko odczyt) i pokazuje je obok własnych pul. Co 5 minut odświeża procenty, a gdy Polymarket rozstrzygnie rynek, bot sam rozlicza zakłady:

- wynik jest uznany dopiero, gdy rynek jest zamknięty, rozstrzygnięty i dokładnie jedna opcja ma cenę 1 (reszta 0);
- jeśli Polymarket ogłosi remis 50/50, rynek zostaje anulowany ze zwrotem stawek;
- w każdym innym, niejasnym przypadku bot nic nie robi i rynek rozstrzygasz ręcznie w panelu.

Rynki z wieloma kandydatami („Kto wygra?") stają się jedną opcją na kandydata. Procenty Polymarketa służą tylko do podglądu — wypłaty zawsze liczone są z pul serwera.

## Własne rynki

W panelu wpisz pytanie, opcje (jedna w linii) i opcjonalnie termin zakładów, a następnie wybierz kanał. Po zakończeniu wydarzenia wybierz zwycięską opcję i kliknij **Rozstrzygnij** albo **Anuluj i zwróć**. Rozstrzygnięcia nie da się cofnąć.

## Komendy

| Komenda | Działanie |
| --- | --- |
| `/rynki lista` | Otwarte rynki z pulą i faworytem. |
| `/rynki moje` | Twoje ostatnie zakłady i ich wynik. |
| `/rynki ranking` | Najlepsi typerzy (zysk netto z rozliczonych zakładów). |

## Ustawienia

Minimalna i maksymalna stawka oraz domyślny kanał. Maksymalnie 25 otwartych rynków na serwer. Usunąć można tylko rynek zakończony lub anulowany.
