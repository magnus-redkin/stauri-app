# chat_sa_sim — переписка Stauri Android (SA) ↔ Status Desktop (SIM)

scenario: chat_sa_sim
sides: SA (проверяется по трассе телефона), SIM (только по действиям; её лог недоступен).

## Предусловия

1. Чистые клиенты: `./scripts/reset-test-clients.sh SA SIM`.
2. SA и SIM: по одному профилю; имена любые.
3. Метка: `./tests/scenarios/run.sh start chat_sa_sim` (после входа, до первого шага).
4. Телефон не спит, Stauri открыт на Chat.

## Шаги (порядок важен, зеркало chat_sd_sim)

1. SA: Chat → Join by invite → вставить инвайт из SIM (SIM → Share profile) → Connect.
   Точка: SA — «Contact request sent».
2. SIM: принять заявку (Accept).
   Точка: SIM — контакт добавлен.
3. SA: ждать до 20 с.
   Точка: в SA открылся чат с SIM.
4. SA: написать любое сообщение → Send.
   Точка: сообщение видно в ленте SA.
5. SIM: получить сообщение, написать любой ответ.
   Точка: ответ отправлен из SIM.
6. SA: ждать до 20 с.
   Точка: ответ из шага 5 видно в SA.

Метка конца: `./tests/scenarios/run.sh end`, затем `./tests/scenarios/run.sh compare`.

## expect sa

- [scenario reply-sync/contact-request-2-sent]
- [scenario reply-sync/poll-changed]
- [scenario reply-sync/sent]
- [scenario reply-sync/poll-reloaded]
