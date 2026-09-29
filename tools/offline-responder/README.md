# offline-responder

Responde por Telegram cuando **ninguna sesión de pi está escuchando**. Sin él, un
mensaje enviado con el Chief apagado se queda sin respuesta hasta que alguien lo
vuelve a encender, sin ninguna señal para quien escribió.

Solo avisa. Nunca consume un mensaje: pi los recibe todos cuando vuelve.

## Uso

```bash
offline-responder once     # una pasada y sale (para probar)
offline-responder start    # arranca en segundo plano
offline-responder status   # informa el pid, el estado del latido y los avisos enviados
offline-responder stop     # detiene el proceso en segundo plano
```

## Cómo sabe que pi está apagado

La extensión `pi-telegram` escribe un latido en `~/.pi/agent/telegram-heartbeat.json`
(`{pid, updatedAt}`) **antes de cada `getUpdates`**, y lo borra al desconectarse o al
cerrar la sesión. Solo lo escribe la sesión que realmente hace polling, que es una
sola: `pollLoop` corre únicamente donde se ejecutó `/telegram-connect`.

Cada 20 segundos el responder lee ese archivo:

- **Latido de menos de 90 s** (dos ciclos del long poll de 30 s): pi está escuchando.
  No se llama a la Bot API. Esto es lo que evita un `409 Conflict` contra pi.
- **Latido viejo o inexistente**: pi está apagado y se contesta.

## Por qué no le roba mensajes a pi

Telegram confirma (y borra) un update recién cuando se pide un `offset` **mayor** a
su `update_id`. El responder llama a `getUpdates` con exactamente el mismo offset con
el que pi reanuda el polling — `lastUpdateId + 1`, leído de `~/.pi/agent/telegram.json` —
y nunca uno mayor. Así ve los mensajes pendientes sin confirmar ninguno.

Si Telegram responde **409**, significa que pi volvió y tomó el long poll: no es un
error, la pasada termina en silencio y se reintenta en la siguiente.

## Deduplicación

Los `update_id` ya respondidos se guardan en `~/.cache/pi-telegram-offline/state.json`.
A cada tanda de mensajes nuevos se le contesta **una sola vez**, encadenada al primer
mensaje sin responder. Un mensaje posterior abre una tanda nueva y recibe su propio
aviso. Si el envío falla, no se marca nada: la pasada siguiente reintenta.

## Credenciales

El token y el destinatario salen de `~/.pi/agent/telegram.json` (`botToken` y
`allowedUserId`). El token se le pasa a `curl` por entrada estándar con `--config -`,
así que no aparece en la lista de procesos, ni en el log, ni en el archivo de estado.
Solo se contestan mensajes privados de `allowedUserId`.

## Archivos

| Ruta | Contenido |
| --- | --- |
| `~/.cache/pi-telegram-offline/log` | Registro de actividad; rota a `log.1` al pasar 1 MB |
| `~/.cache/pi-telegram-offline/state.json` | Últimos 500 `update_id` ya respondidos |
| `~/.cache/pi-telegram-offline/pid` | Pid del proceso en segundo plano |

## Variables de entorno

| Variable | Valor por defecto | Efecto |
| --- | --- | --- |
| `PI_TELEGRAM_OFFLINE_INTERVAL` | `20` | Segundos entre pasadas |
| `PI_TELEGRAM_OFFLINE_HEARTBEAT_MAX_AGE` | `90` | Segundos que un latido se considera fresco |
| `PI_TELEGRAM_OFFLINE_API` | `https://api.telegram.org` | Base de la Bot API (las pruebas apuntan a un servidor local) |
| `PI_TELEGRAM_OFFLINE_CACHE` | `~/.cache/pi-telegram-offline` | Carpeta de estado y log |
| `PI_TELEGRAM_OFFLINE_FOREGROUND` | vacío | Con `1`, `start` corre en primer plano (systemd) |
| `PI_TELEGRAM_OFFLINE_ECHO` | vacío | Con `1`, además escribe el log en la salida estándar |

## systemd (no instalado)

`pi-telegram-offline.service` es una unidad de usuario lista para copiar. **No está
instalada**; el paso de instalación queda a criterio de quien administra la máquina:

```bash
cp tools/offline-responder/pi-telegram-offline.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram-offline.service
```

La unidad asume que el repo vive en `~/proyectos/pi-telegram`. Si está en otro lado,
hay que ajustar `ExecStart` antes de copiarla.

## Pruebas

```bash
python3 tools/offline-responder/test_offline_responder.py
```

Levantan un Telegram falso (`http.server` local) y verifican: latido fresco → cero
llamadas a la API; latido viejo → un aviso con `offset` exactamente `lastUpdateId + 1`;
segunda pasada → sin repetir; `409` → sin aviso; mensajes de otra cuenta → ignorados.

## Limitaciones conocidas

- Depende del latido: una versión de `pi-telegram` anterior a este cambio no lo
  escribe, así que el responder la trataría como apagada y contestaría mientras pi
  también está escuchando (el 409 lo protege, pero el aviso ya salió).
- Si `~/.pi/agent/telegram.json` no tiene `lastUpdateId`, se llama sin `offset`. Eso
  tampoco confirma nada, pero puede traer mensajes viejos que Telegram todavía guarda.
- No responde nada que no sea un chat privado del usuario habilitado.
