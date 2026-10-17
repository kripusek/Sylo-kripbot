# Relay głosowy

Przekazuje na żywo rozmowę z jednego kanału głosowego na drugi, żeby połączyć dwa czaty głosowe na serwerze.

## Dlaczego potrzebny jest drugi bot

Discord pozwala botowi być tylko na **jednym** kanale głosowym serwera naraz. Relay między dwoma kanałami tego samego serwera używa więc dwóch kont:

- **główny bot** dołącza do kanału **wejściowego** i słucha,
- **bot relay** (drugie konto) dołącza do kanału **wyjściowego** i odtwarza to, co usłyszał.

W trybie **dwukierunkowym** oba boty robią też drugą robotę, więc oba kanały słyszą się nawzajem.

## Konfiguracja

1. W Discord Developer Portal utwórz **drugą aplikację** z botem. Nie potrzebuje żadnych uprawnień uprzywilejowanych (Privileged Intents).
2. Wklej jej token do `.env` (na Pelican do zmiennej startowej) jako `RELAY_BOT_TOKEN` i zrestartuj bota.
3. Zaproś bota relay na serwer. Dla jego kanału potrzebuje uprawnień **Wyświetlanie kanału, Łączenie i Mówienie**. Główny bot potrzebuje **Łączenia** na kanale wejściowym (w trybie dwukierunkowym także **Mówienia**).
4. Włącz moduł **Relay głosowy**, wybierz kanały i zaznacz **Relay włączony**, a następnie zapisz.

## Sterowanie

W panelu (V1 i V2):

- wybór kanału wejściowego i wyjściowego,
- przycisk **Zamień wejście z wyjściem** odwraca kierunek,
- **Dwukierunkowo**, **komunikat przy starcie** i **Relay włączony**.

Komendy (wymagają uprawnienia Zarządzanie serwerem):

| Komenda | Działanie |
| --- | --- |
| `/relay start [wejscie] [wyjscie] [dwukierunkowo]` | Uruchamia relay (puste pola biorą wartości z panelu). |
| `/relay zamien` | Zamienia wejście z wyjściem, czyli odwraca kierunek. |
| `/relay stop` | Zatrzymuje relay. |
| `/relay status` | Pokazuje, czy działa, kierunek i ile osób mówi. |

Relay uruchomiony przed restartem bota wraca sam po kilkunastu sekundach.

## Ograniczenia i uwagi

- Tylko zwykłe kanały głosowe (nie sceny). Boty na kanałach nie są przekazywane dalej.
- Gdy relay działa, na tym serwerze nie da się używać **muzyki** ani **soundboardu**, bo główny bot jest zajęty kanałem wejściowym. Odwrotnie: relay nie wystartuje, gdy muzyka lub soundboard są aktywne.
- Dźwięk ma niewielkie opóźnienie (dziesiątki do kilkuset ms). Gdy mówi kilka osób naraz, ich głosy są miksowane.
- Nic nie jest nagrywane ani zapisywane. Mimo to osoby na kanałach powinny wiedzieć, że ich głos jest przekazywany, dlatego przy starcie bot pisze komunikat na czacie obu kanałów (można wyłączyć).
- Odbiór głosu to mniej oficjalna część API Discorda. Jeśli Discord zmieni protokół, relay może wymagać aktualizacji `@discordjs/voice`.
