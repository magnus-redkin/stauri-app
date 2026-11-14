# chat_sd_sa — переписка Stauri Desktop (SD) ↔ Stauri Android (SA)

scenario: chat_sd_sa
sides: SD, SA (телефон). Имена профилей любые: их пишут в журнал прогона, в проверки не входят.

## Предусловия

1. Чистые клиенты: `./scripts/reset-test-clients.sh SA SD`.
2. SD и SA: по одному профилю, пароль введён один раз.
3. Метка: `./tests/scenarios/run.sh start chat_sd_sa` (после входа, до первого шага).
4. SD не перезапускать до конца. Телефон не спит, Stauri открыт на Chat.

## Шаги (порядок важен)

1. SA: Chat → Join by invite → вставить инвайт из SD (Chat → invite на SD) → Connect.
   Точка: SA — «Contact request sent».
2. SD: ждать до 20 с → строка с «!» → тап → Accept.
   Точка: SD — чат открыт, поле ввода активно.
3. SD: написать любое сообщение → Send.
   Точка: сообщение видно в ленте SD.
4. SA: ждать до 20 с.
   Точка: сообщение из шага 3 видно в SA.
5. SA: написать любой ответ → Send.
   Точка: ответ видно в ленте SA.
6. SD: ждать до 20 с.
   Точка: ответ из шага 5 видно в SD.

Метка конца: `./tests/scenarios/run.sh end`, затем `./tests/scenarios/run.sh compare`.

## expect sd

- [scenario reply-sync/incoming-request]
- [scenario reply-sync/accepted]
- CallRPC/wakuext_sendChatMessage ok
- [scenario reply-sync/poll-reloaded] | [scenario reply-sync/reloaded]
- not: CallRPC/wakuext_sendChatMessage error

## expect sa

- [scenario reply-sync/contact-request-2-sent]
- [scenario reply-sync/poll-reloaded]
- [scenario reply-sync/sent]
