# chat_sd_sim — переписка Stauri Desktop (SD) ↔ Status Desktop (SIM)

scenario: chat_sd_sim
sides: SD (проверяется по логу), SIM (только по действиям; её лог недоступен).

## Предусловия

1. Чистые клиенты: `./scripts/reset-test-clients.sh SIM SD`.
2. SD и SIM: по одному профилю; имена любые.
3. Метка: `./tests/scenarios/run.sh start chat_sd_sim` (после входа, до первого шага).
4. SD не перезапускать до конца.

## Шаги (порядок важен, те же, что в chat_sd_sa)

1. SIM: Contacts → Send contact request → вставить инвайт из SD (Chat → invite на SD).
2. SD: ждать до 20 с → строка с «!» → тап → Accept.
   Точка: SD — чат открыт.
3. SD: написать любое сообщение → Send.
   Точка: сообщение видно в ленте SD.
4. SIM: получить сообщение.
   Точка: сообщение из шага 3 видно в SIM.
5. SIM: написать любой ответ → Send.
   Точка: ответ отправлен из SIM.
6. SD: ждать до 20 с.
   Точка: ответ из шага 5 видно в SD.

Метка конца: `./tests/scenarios/run.sh end`, затем `./tests/scenarios/run.sh compare`.

## expect sd

- [scenario reply-sync/incoming-request]
- [scenario reply-sync/accepted]
- CallRPC/wakuext_sendChatMessage ok
- [scenario reply-sync/poll-reloaded] | [scenario reply-sync/reloaded]
- not: CallRPC/wakuext_sendChatMessage error
