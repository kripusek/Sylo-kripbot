# Automatyczne wątki

Włącz moduł **Automatyczne wątki** i wybierz kanały w panelu V1 lub V2.
Każda nowa wiadomość człowieka na wybranym kanale tekstowym lub ogłoszeń tworzy publiczny wątek. Boty, webhooki, wiadomości systemowe, istniejące wątki i inne typy kanałów są pomijane. Starsze wiadomości nie są przetwarzane.

Nazwa obsługuje `{author}` i `{message}` (treść wymaga Message Content Intent); maksymalnie 100 znaków. Domyślnie: `Dyskusja — {author}`. Archiwizacja po braku aktywności: godzina, dzień, 3 lub 7 dni.

Uprawnienia bota na kanałach: View Channel, Read Message History, Create Public Threads. Aby pisać we wątkach, także Send Messages in Threads. Błędy Discord API są zapisywane w konsoli jako `module:auto-threads`.

Aktualizacja na Pelicanie: pobierz zmiany z forka, uruchom `npm run build:v2`, następnie uruchom bota. Nie usuwaj `.env` ani katalogu `data`.
