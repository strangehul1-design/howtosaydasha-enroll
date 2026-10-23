# Файлы с рекомендациями по уровням

Эти файлы Дарья отправляет ученикам после теста уровня: кнопка «📎 Отправить файл уровня …» в боте подставляет в сообщение ссылку на нужный файл.

| Результат теста | Файл |
|---|---|
| A1 и A2 | `howtosaydasha_Rekomendacii_A1-A2.pdf` |
| B1 | `howtosaydasha_Rekomendacii_B1.pdf` |
| B2 | `howtosaydasha_Rekomendacii_B2.pdf` |
| C1 | `howtosaydasha_Rekomendacii_C1-C2.pdf` |

Ссылка выглядит так: `https://strangehul1-design.github.io/howtosaydasha-enroll/materials/howtosaydasha_Rekomendacii_B1.pdf`.

## Как заменить файл

Положите новый PDF в эту папку **с тем же именем** и закоммитьте: ссылка останется прежней. Если имя меняется, поправьте его в объекте `LEVEL_FILES` в `worker/worker.js` и заново разверните воркер (`npx wrangler@4 deploy` в папке `worker`).

Репозиторий публичный, поэтому всё, что лежит в этой папке, доступно по ссылке любому. Не кладите сюда то, что должно оставаться платным или закрытым.
